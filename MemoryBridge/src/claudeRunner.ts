// claudeRunner - 唤起 claude -p headless 实例，复用 Claude 完整能力。
// 桥接服务只做转发：飞书消息 -> spawn claude -p（腾讯Mem记忆绑定 header + 飞书认证）-> 回复。
// 记忆绑定：ANTHROPIC_CUSTOM_HEADERS 携带 x-* header，proxy 据此注册 session + 注入记忆/知识库工具。
// 流式：--output-format stream-json + --include-partial-messages，增量通过 onDelta 推给飞书打字机卡片。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeishuCreds } from './docShare.js';
import { resolveSessionId, sessionArgv, SESSION_MODE_LABEL, withSessionLock, type SessionMode } from './sessionMode.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_CLAUDE = process.env.CLAUDE_BIN || 'claude';
const EMBED_SCRIPT = join(__dirname, '..', 'scripts', 'embed-prototype.mjs');

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

【回答】
- 直接、简洁地回答用户问题，不要输出工具调用语法或 XML 标签。`;
}

type Delta =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'assistant'; content: Array<Record<string, unknown>> }
  | { kind: 'result'; text: string };

/** 从 claude stream-json 一行里抽出要展示的增量。 */
export function extractStreamDelta(evt: unknown): Delta | null {
  if (!evt || typeof evt !== 'object') return null;
  const outer = evt as {
    type?: string;
    event?: unknown;
    message?: { content?: unknown };
    result?: unknown;
  };
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

export function createClaudeRunner({
  baseUrl, userKey, binding, model, name, workDir, feishu, systemRules, sessionMode = 'none',
}: ClaudeRunnerOptions): ClaudeRunner {
  const rules = systemRules || defaultRules(name);
  const MAX_RETRIES = 2;

  function attempt(
    userMessage: string,
    conversationId: string,
    onDelta: ((text: string) => Promise<void>) | undefined,
    chatId: string | undefined,
    signal: AbortSignal | undefined,
    sessionId: string | null,
  ): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
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
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '500000',
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

      function emit(text: string) {
        if (!text) return;
        visible += text;
        if (onDelta) push = push.then(() => onDelta(text)).catch(() => {});
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
          emit(`\n\n_调用 ${delta.name}…_\n\n`);
          return;
        }
        if (delta.kind === 'assistant' && !gotPartial) {
          for (const block of delta.content) {
            if (block.type === 'text' && typeof block.text === 'string') emit(block.text);
            if (block.type === 'tool_use') emit(`\n\n_调用 ${String(block.name ?? '工具')}…_\n\n`);
          }
          return;
        }
        if (delta.kind === 'result') finalResult = delta.text;
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
        settle(reject, new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => settle(reject, err));
      child.on('close', (code) => {
        const tail = buf.trim();
        if (tail) {
          try { handleEvent(JSON.parse(tail)); } catch { /* ignore */ }
        }
        push.then(() => {
          if (signal?.aborted) {
            settle(reject, new Error('aborted'));
            return;
          }
          const text = (visible || finalResult).trim();
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
          if (!(err instanceof Error) || streamed || err.message === 'aborted') break;
          console.warn(`[claude] 第${i + 1}次失败，重试中: ${err.message.slice(0, 80)}`);
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
      throw lastErr;
    });
  }

  return { run };
}
