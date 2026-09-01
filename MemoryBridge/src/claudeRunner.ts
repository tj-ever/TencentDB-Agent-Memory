// claudeRunner - 唤起 claude -p headless 实例，复用 Claude 完整能力。
// 桥接服务只做转发：飞书消息 -> spawn claude -p（腾讯Mem记忆绑定 header + 飞书认证）-> 回复。
// 记忆绑定：ANTHROPIC_CUSTOM_HEADERS 携带 x-* header，proxy 据此注册 session + 注入记忆/知识库工具。
// 流式：--output-format stream-json + --include-partial-messages，增量通过 onDelta 推给飞书打字机卡片。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeishuCreds } from './docShare.js';
import { resolveSessionId, sessionArgv, SESSION_MODE_LABEL, withSessionLock, type SessionMode } from './sessionMode.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_CLAUDE = process.env.CLAUDE_BIN || 'claude';
const EMBED_SCRIPT = join(__dirname, '..', 'scripts', 'embed-prototype.mjs');
const PUBLISH_SCRIPT = join(__dirname, '..', 'scripts', 'publish-doc.mjs');

const BASE_REQUIREMENTS = '始终使用简体中文回复用户，不要用英文或中英混杂。';

function defaultRules(name: string): string {
  return `你是「${name}」飞书机器人，只服务当前用户关于本项目的问答。

【工作边界】
- 本机文件只允许当前工作目录。禁止读取、探索、提及本机其他项目或文件。
- 禁止用本机 CLAUDE.md / MEMORY.md / 其他工程路径替代腾讯 Mem。
- 腾讯 Mem（记忆 + 知识库）不受此边界限制，必须完整使用。

【腾讯 Mem：全开，先查再答】
proxy 已按当前 team/agent/task 注入记忆工具与知识库工具。涉及记忆、历史、约定、项目、需求时，必须先用这些注入工具查询，再作答。
若注入工具的 url 在当前环境不可达（如 host.docker.internal），改用 127.0.0.1 或同网络容器名（tdai-proxy / tdai-memory-core）重试后再报告失败。
查不到才说「暂无记录」，禁止编造。

【工具与技能】
- 只能调用工具列表里实际存在的名称；报「Unknown tool / Unknown skill」即该名称不存在，禁止换相近名字反复猜。
- 需要记忆/知识库能力但没找到对应工具时如实说明，禁止编造工具名。

【生成交互原型】
- 用户要求「设计整套页面 / 交互原型 / UI / 页面布局 / 把页面做出来」时：用 skill \`epm-prototype-html\` 生成自包含交互 HTML 原型（按该 skill：覆盖矩阵 → 单文件 HTML → 校验 → 验收），保存到工作目录，文件名用页面语义。
- 禁止把 HTML 源码或文件内容当作聊天回复粘贴；聊天里只允许一句摘要 + 飞书文档链接。
- 原型投递：node "$FEISHU_EMBED_PROTOTYPE" <文档id> <html路径> "页面名"（截图 + 可交互 HTML 文件块）。

【飞书交付】
- 整篇文档正文发布：node "$FEISHU_PUBLISH_DOC" <markdown文件> [--title 标题]。分批 + 断点续传，中途失败重跑同命令即从断点继续。禁止手写建文档/建块的内联脚本。
- 原型截图 + HTML 附件：node "$FEISHU_EMBED_PROTOTYPE" <文档id> <html路径> [小标题]。
- 文档链接原样输出 https://my.feishu.cn/docx/<文档id>，权限会自动放开。

【迭代即原地更新，禁止增殖版本】
- 用户消息里带文档链接 + 修改建议时：这是要你改原文档，不是新建。先在 workspace/deliverables.json（$FEISHU_DELIVERABLES）里按链接里的文档 id 查登记，然后用 node "$FEISHU_PUBLISH_DOC" <只含该段新内容的md> --doc-id <文档id> --update-section "锚点标题" 原地替换对应章节；原型迭代用 node "$FEISHU_EMBED_PROTOTYPE" <文档id> <html路径> --update 原地刷新截图与附件。
- 找不到登记或锚点标题时，先向用户确认「没找到原文档记录，是要新出一版还是重发链接」，不要默默新建第 V2/V3 版文档。
- 禁止用「V2」「按N条建议修改」之类新标题另建文档替代原地更新。

【命名口径沉淀】
- 被用户纠正命名/口径后，把该口径追加到工作目录 terminology.md（该文件存在即自动注入后续所有会话）。

【大生成先确认】
- 全新方案/PRD 这类大交付（预计发布整篇文档或原型）前，先用一小段话向用户复述你理解的模块/页面/字段清单，收到「可以/确认/开始」等肯定回复后再动手。用户消息已经足够明确（列清了模块/页面/字段）时可直接开始，不必追问。

【回答】
- 直接、简洁地回答用户问题，不要输出工具调用语法或 XML 标签。`;
}

// MiniMax 系上游把推理过程内联在正文里（<mm:think>…</mm:think>），
// 流式增量与最终文本都必须剥掉，否则推理原文直接刷到用户卡片。
export function createThinkFilter(): { push(chunk: string): string; flush(): string } {
  const OPEN = '<mm:think>';
  const CLOSE = '</mm:think>';
  let inThink = false;
  let hold = ''; // 末尾疑似半个标签的片段，扣下等下一个增量再判
  const push = (chunk: string): string => {
    let s = hold + chunk;
    hold = '';
    let out = '';
    for (;;) {
      const tag = inThink ? CLOSE : OPEN;
      const i = s.indexOf(tag);
      if (i < 0) break;
      if (!inThink) out += s.slice(0, i);
      s = s.slice(i + tag.length);
      inThink = !inThink;
    }
    // 尾部可能是半个标签（增量边界切在标签中间）：扣住，其余按模式放行/丢弃。
    const tag = inThink ? CLOSE : OPEN;
    for (let k = Math.min(s.length, tag.length - 1); k > 0; k--) {
      if (tag.startsWith(s.slice(-k))) { hold = s.slice(-k); s = s.slice(0, -k); break; }
    }
    if (!inThink) out += s;
    return out;
  };
  // 流结束：扣着的尾巴按字面放行；think 未闭合则丢弃剩余。
  const flush = (): string => {
    const rest = hold;
    hold = '';
    return inThink ? '' : rest;
  };
  return { push, flush };
}

const THINK_RE = /<mm:think>[\s\S]*?<\/mm:think>/g;

// 配额耗尽时 claude CLI 会把英文 "API Error: …(429)… reset at …" 当正文吐出，
// 转成用户能看懂的中文提示（含重置时间）。
export function friendlyUpstreamError(text: string): string | null {
  if (!/^API Error/i.test(text.trim())) return null;
  const m = /reset at ([\d:\- +]+)/.exec(text);
  return `⏳ 上游模型额度暂时用尽${m ? `（预计 ${m[1]!.trim()} 恢复）` : ''}，请稍后重新发送需求。`;
}

type Delta =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'assistant'; content: Array<Record<string, unknown>> }
  | { kind: 'result'; text: string }
  | { kind: 'retry'; attempt: number; maxRetries: number; status: number; delayMs: number };

/** 从 claude stream-json 一行里抽出要展示的增量。 */
export function extractStreamDelta(evt: unknown): Delta | null {
  if (!evt || typeof evt !== 'object') return null;
  const outer = evt as {
    type?: string;
    subtype?: string;
    event?: unknown;
    message?: { content?: unknown };
    result?: unknown;
    attempt?: number;
    max_retries?: number;
    error_status?: number;
    retry_delay_ms?: number;
  };
  // 上游限流/网络错误重试：headless stream-json 会发 system/api_retry 事件。
  if (outer.type === 'system' && outer.subtype === 'api_retry') {
    return {
      kind: 'retry',
      attempt: outer.attempt ?? 0,
      maxRetries: outer.max_retries ?? 0,
      status: outer.error_status ?? 0,
      delayMs: outer.retry_delay_ms ?? 0,
    };
  }
  const ev = (outer.type === 'stream_event' ? outer.event : evt) as {
    type?: string;
    delta?: { text?: string };
    content_block?: { type?: string; name?: string };
  } | undefined;
  if (ev?.type === 'content_block_delta' && ev.delta?.text) {
    return { kind: 'text', text: ev.delta.text };
  }
  if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
    return { kind: 'tool', name: ev.content_block.name || '工具' };
  }
  if (outer.type === 'assistant') {
    const content = Array.isArray(outer.message?.content) ? outer.message!.content as Array<Record<string, unknown>> : [];
    return { kind: 'assistant', content };
  }
  if (outer.type === 'result' && typeof outer.result === 'string') {
    return { kind: 'result', text: outer.result };
  }
  return null;
}

export interface ClaudeRunnerOptions {
  baseUrl: string;
  userKey: string;
  binding: { team_id: string; agent_id: string; task_id: string };
  model: string;
  name: string;
  workDir: string;
  feishu?: FeishuCreds;
  systemRules?: string | null;
  sessionMode?: SessionMode;
}

export interface ClaudeRunner {
  run(
    message: string,
    conversationId: string,
    onDelta?: (text: string) => Promise<void>,
    chatId?: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

// 项目术语表（workspace/terminology.md）：历史纠错沉淀的命名/口径约定，存在即注入
// system prompt，让「办公地点≠工作地点」这类反复纠正过的错一次改对。
function terminologySection(workDir: string): string {
  try {
    const p = join(workDir, 'terminology.md');
    if (!existsSync(p)) return '';
    const text = readFileSync(p, 'utf8').trim();
    if (!text) return '';
    return `\n\n【项目术语与口径（必须遵守）】\n${text}`;
  } catch { return ''; }
}

export function createClaudeRunner({
  baseUrl, userKey, binding, model, name, workDir, feishu, systemRules, sessionMode = 'none',
}: ClaudeRunnerOptions): ClaudeRunner {
  // 通用基线（交付/原型/质量规则）对所有 bot 生效；system_prompt 是项目业务增量，
  // 追加在基线之后合并注入，而不是整体覆盖（覆盖会让自定义 bot 丢失质量规则）。
  const rules = [BASE_REQUIREMENTS, defaultRules(name), systemRules, terminologySection(workDir)]
    .filter(Boolean).join('\n\n');
  const MAX_RETRIES = 2;

  // abort 原因透传：撤回中止（abort(new Error('recalled'))）与普通中止区分，
  // 下游（streamRotate 卡片尾注）据此显示「消息已撤回」还是「已停止生成」。
  const abortError = (signal: AbortSignal | undefined): Error =>
    signal?.reason instanceof Error ? signal.reason : new Error('aborted');

  function attempt(
    userMessage: string,
    conversationId: string,
    onDelta: ((text: string) => Promise<void>) | undefined,
    chatId: string | undefined,
    signal: AbortSignal | undefined,
    sessionId: string | null,
  ): Promise<string> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: userKey,
        ANTHROPIC_CUSTOM_HEADERS: [
          `x-team-id: ${binding.team_id}`,
          `x-agent-id: ${binding.agent_id}`,
          `x-task-id: ${binding.task_id}`,
          `x-conversation-id: ${conversationId}`,
        ].join('\n'),
        FEISHU_APP_ID: feishu?.app_id,
        FEISHU_APP_SECRET: feishu?.app_secret,
        FEISHU_OPEN_ID: conversationId,
        FEISHU_CHAT_ID: chatId || '',
        FEISHU_EMBED_PROTOTYPE: EMBED_SCRIPT,
        FEISHU_PUBLISH_DOC: PUBLISH_SCRIPT,
        // 交付物注册表：脚本成功后自动登记 doc_id/块 id，迭代请求据此路由回原文档
        FEISHU_DELIVERABLES: join(workDir, 'deliverables.json'),
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '500000',
        // 上游 429/网络错误时 claude 内部重试的最大次数；重试期间会话不中断，
        // 每次重试通过 system/api_retry 事件回传打字机。10 次全失败后 claude 才放弃。
        CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES || '10',
        // claude 默认 Bash 超时 2min，整篇文档发布这类长脚本会被 SIGTERM(143) 砍成半成品，放宽到 10min。
        BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS || '600000',
        BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS || '1200000',
      };

      const extra = sessionArgv(workDir, sessionId);
      if (sessionId) {
        console.log(`[claude] ${SESSION_MODE_LABEL[sessionMode]} ${extra[0] === '--resume' ? 'resume' : 'new'} ${sessionId}`);
      }

      const child = spawn(DEFAULT_CLAUDE, [
        '-p', userMessage,
        '--model', model,
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--system-prompt', rules,
        '--dangerously-skip-permissions',
        ...extra,
      ], { env, cwd: workDir, shell: false });

      let buf = '';
      let visible = '';
      let gotPartial = false;
      let finalResult = '';
      let push = Promise.resolve();
      const think = createThinkFilter();
      // 回复开头先攒 32 字符再放行：判断是不是上游错误文本（API Error…429），
      // 是则整段拦下，不让英文报错刷到卡片。短回复由 close 时补发。
      let head: string | null = '';
      let quotaMsg: string | null = null;

      function emit(text: string) {
        if (!text) return;
        const out = think.push(text);
        visible += out;
        if (!out || quotaMsg) return;
        if (head !== null) {
          head += out;
          if (head.length < 32) return;
          const bad = friendlyUpstreamError(head);
          if (bad) { quotaMsg = bad; notify(bad); return; }
          text = head;
          head = null;
        }
        if (onDelta) push = push.then(() => onDelta(text)).catch(() => {});
      }

      // 合成提示（工具调用/限流重试）只推给打字机卡片，不进 visible——
      // visible 是最终回复文本，混入会把「调用 X…」当正文发给用户（非流式 fallback 必现）。
      function notify(text: string) {
        if (!text || !onDelta) return;
        push = push.then(() => onDelta(text)).catch(() => {});
      }

      function handleEvent(evt: unknown) {
        const delta = extractStreamDelta(evt);
        if (!delta) return;
        if (delta.kind === 'text') {
          gotPartial = true;
          emit(delta.text);
          return;
        }
        if (delta.kind === 'tool') {
          notify(`\n\n_调用 ${delta.name}…_\n\n`);
          return;
        }
        if (delta.kind === 'retry') {
          const s = delta.status === 429 ? '上游限流(429)' : `上游错误(${delta.status || '网络'})`;
          const wait = delta.delayMs ? `，${Math.round(delta.delayMs / 1000)}s 后` : '，';
          const n = delta.maxRetries ? `第 ${delta.attempt}/${delta.maxRetries} 次` : `第 ${delta.attempt} 次`;
          notify(`\n\n_${s}${wait}重试（${n}）…_\n\n`);
          return;
        }
        if (delta.kind === 'assistant' && !gotPartial) {
          for (const block of delta.content) {
            if (block.type === 'text' && typeof block.text === 'string') emit(block.text);
            if (block.type === 'tool_use') notify(`\n\n_调用 ${String(block.name ?? '工具')}…_\n\n`);
          }
          return;
        }
        if (delta.kind === 'result') finalResult = delta.text.replace(THINK_RE, '');
      }

      child.stdout.on('data', (d) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { handleEvent(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
        }
      });
      child.stderr.on('data', () => {});

      let settled = false;
      const settle = (fn: (v: never) => void, value: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        (fn as (v: unknown) => void)(value);
      };
      const onAbort = () => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        settle(reject, abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => settle(reject, err));
      child.on('close', (code) => {
        const tail = buf.trim();
        if (tail) {
          try { handleEvent(JSON.parse(tail)); } catch { /* ignore */ }
        }
        // 流结束时还扣着的半个标签尾巴按字面放行
        const tailThink = think.flush();
        if (tailThink) emit(tailThink);
        // 短回复（不足 32 字符）开头缓冲没放行过，close 时补发给卡片
        if (head !== null && head && !quotaMsg) {
          const rest = head;
          if (onDelta) push = push.then(() => onDelta(rest)).catch(() => {});
        }
        push.then(() => {
          if (signal?.aborted) {
            settle(reject, abortError(signal));
            return;
          }
          const raw = (visible || finalResult).trim();
          const text = quotaMsg ?? friendlyUpstreamError(raw) ?? raw;
          if (code === 0 || text) settle(resolve, text);
          else settle(reject, new Error(`claude exit ${code}`));
        }, (err: unknown) => settle(reject, err));
      });
    });
  }

  async function run(
    userMessage: string,
    conversationId: string,
    onDelta?: (text: string) => Promise<void>,
    chatId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const sessionId = resolveSessionId({
      mode: sessionMode,
      botName: name,
      userId: conversationId,
      chatId,
    });
    return withSessionLock(sessionId, async () => {
      let lastErr: unknown;
      let streamed = false;
      const wrapped = onDelta && ((t: string) => {
        streamed = true;
        return onDelta(t);
      });
      for (let i = 0; i <= MAX_RETRIES; i++) {
        try {
          return await attempt(userMessage, conversationId, wrapped, chatId, signal, sessionId);
        } catch (err) {
          lastErr = err;
          if (!(err instanceof Error) || streamed || signal?.aborted) break;
          console.warn(`[claude] 第${i + 1}次失败，重试中: ${err.message.slice(0, 80)}`);
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
      throw lastErr;
    });
  }

  return { run };
}
