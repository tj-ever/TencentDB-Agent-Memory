import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLarkChannel, defaultLogger, LoggerLevel, type LarkChannel } from '@larksuiteoapi/node-sdk';
import { createClaudeRunner, type ClaudeRunner } from './claudeRunner.js';
import { extractDriveFiles, openDocsFromText, rewriteFeishuHost } from './docShare.js';
import { runWithRotatingMarkdown } from './streamRotate.js';
import { resolveSessionId, SESSION_MODE_LABEL } from './sessionMode.js';
import { getBot, listBots, updateBot, type Bot, type BotStatus } from './store.js';
import { enqueue, dequeue, loadQueue, type PendingMsg } from './messageQueue.js';
import { clearBotSession as clearSession, listBotSessions, rememberSessionUser, type SessionMeta } from './sessionManager.js';

const running = new Map<string, { channel: LarkChannel | null; error: string | null; abort?: () => boolean }>();

// 会话重置指令（整条消息只有指令本身才算，正文里提到不算）。
const RESET_CMD_RE = /^\/?(?:重置|清空|reset|clear)(?:会话|上下文|对话|session|context)?$|^\/?(?:重新开始|新对话|新会话)$/i;

// 帮助指令：能力边界 + 用法一句话。业务人员不读文档，指令自解释是唯一触达路径。
const HELP_CMD_RE = /^\/?(?:help|帮助|怎么用|使用说明|你能做什么|你能干什么)$/i;
const HELP_TEXT = [
  '🤖 我能做什么：',
  '• 生成/修改方案文档、PRD、交互原型（HTML 可点开演示）',
  '• 查询项目记忆与知识库里的历史约定',
  '',
  '怎么用：',
  '• 直接描述需求即可，长需求建议写清模块/页面/字段',
  '• 改已有交付物：把文档链接 + 修改建议发给我，我会原地更新，不会另建新文档',
  '• 发「重置会话」让我忘掉之前对话，重新开始',
  '• 生成大文档耗时较长（10-40 分钟），期间卡片会报进度，请勿重复发送',
].join('\n');

// 已介绍过的用户（每 bot 一份，data/introduced-<botid>.json）——首条消息自动自我介绍。
const DATA_DIR = process.env.BRIDGE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
function introducedPath(botId: string): string {
  return join(DATA_DIR, `introduced-${botId}.json`);
}
function isIntroduced(botId: string, openId: string): boolean {
  try {
    const list = JSON.parse(readFileSync(introducedPath(botId), 'utf8')) as string[];
    return Array.isArray(list) && list.includes(openId);
  } catch { return false; }
}
function markIntroduced(botId: string, openId: string): void {
  try {
    let list: string[] = [];
    try { const j = JSON.parse(readFileSync(introducedPath(botId), 'utf8')); if (Array.isArray(j)) list = j; } catch { /* 首次 */ }
    if (!list.includes(openId)) {
      list.push(openId);
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(introducedPath(botId), JSON.stringify(list));
    }
  } catch { /* 介绍标记失败不影响主流程 */ }
}

// 包装 SDK logger，过滤「no <raw事件> handle」这类无 slot 原始事件的无害告警。
function silentNoHandleWarn() {
  return {
    ...defaultLogger,
    warn: (...args: unknown[]) => {
      const s = String(args[0] ?? '');
      if (s.includes('no ') && s.includes(' handle')) return; // 吞掉，保留其它 warn/error
      return defaultLogger.warn(...(args as [string?, ...unknown[]]));
    },
  };
}

function claudeBaseUrl(bot: Bot): string {
  return `${bot.memory.proxy_base_url.replace(/\/$/, '')}/claude-code/${bot.memory.space_id}`;
}

// 机器人启动时从 Proxy 上游配置读取模型；未配置时直接失败，避免使用过期的本地模型值。
async function resolveUpstreamConfig(bot: Bot): Promise<{ model: string; supportsImages: boolean }> {
  const base = bot.memory.proxy_base_url.replace(/\/$/, '');
  const res = await fetch(`${base}/v3/config/upstream`, {
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'default',
      'x-tdai-user-key': bot.memory.user_key,
    },
  });
  if (!res.ok) {
    throw new Error(`resolve upstream model failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    model?: string;
    supportsImages?: boolean;
    agents?: Array<{ name?: string; model?: string }>;
  };
  const model = data.agents?.find((agent) => agent.name === 'claude-code')?.model || data.model;
  console.log(`[${bot.id}] resolveUpstream → model=${JSON.stringify(model)} supportsImages=${data.supportsImages === true}`);
  if (!model) {
    throw new Error('upstream has no model configured for claude-code');
  }
  return { model, supportsImages: data.supportsImages === true };
}

function attach(bot: Bot, channel: LarkChannel, claude: ClaudeRunner, supportsImages: boolean) {
  async function shareDocs(reply: string | null | undefined, msg: { senderId: string; chatId: string }) {
    if (!reply) return;
    try {
      const rows = await openDocsFromText(reply, bot.feishu, {
        openId: msg.senderId,
        chatId: msg.chatId,
      });
      if (rows.length) console.log(`[${bot.id} doc-share]`, rows.map((r) => r.id).join(','));
    } catch (err) {
      console.error(`[${bot.id} doc-share]`, err instanceof Error ? err.message : String(err));
    }
  }

  let pumping = false;
  let currentAbort: AbortController | null = null;
  let currentMsgId: string | null = null;   // 正在处理的消息 id（撤回时用来区分「生成中」和「排队中」）
  let recalledMsgId: string | null = null;  // 生成中被撤回的消息 id：abort 后 processOne 据此静默跳过
  let queueNoticeSent = false;              // 排队积压提示已发过（队列消化到 ≤2 条后重置）

  // 处理队列里的单条消息（含图片拒绝 + 流式回复 + 错误重试）。
  async function processOne(p: PendingMsg) {
    // 模型不支持识图时，图片消息直接回复拒绝（不丢给 claude，避免 text-only 上游 400）。
    if (!supportsImages && p.image) {
      console.log(`[${bot.id}] 忽略图片消息(模型不支持识图) msg=${p.id} user=${p.senderId}`);
      try {
        await channel.send(p.chatId, { markdown: '当前模型不支持识图，暂无法处理图片，请改用文字描述。' }, { replyTo: p.id });
      } catch (err) { console.error(`[${bot.id}] 图片拒绝回复失败`, err instanceof Error ? err.message : String(err)); }
      return;
    }
    const conversationId = p.senderId;   // 飞书用户 -> 记忆按用户隔离
    console.log(`[${bot.id} ->] ${p.id} user=${p.senderId}`);
    let streamed = false;
    const ac = new AbortController();
    currentAbort = ac;
    currentMsgId = p.id;
    try {
      const reply = await runWithRotatingMarkdown(channel, p.chatId, { replyTo: p.id }, async (ctl) => {
        streamed = true;
        const seenShare = new Set<string>();
        let streamedText = '';
        const text = await claude.run(
          p.content,
          conversationId,
          async (chunk) => {
            const out = rewriteFeishuHost(chunk);
            streamedText += out;
            await ctl.append(out);
            // 链接一出现就提权，避免打字机里先点到 tenant_readable / 错域名
            const fresh = extractDriveFiles(streamedText).filter((f) => !seenShare.has(f.id));
            for (const f of fresh) {
              seenShare.add(f.id);
              await shareDocs(`https://www.feishu.cn/${f.type === 'file' ? 'file' : f.type === 'sheet' ? 'sheets' : 'docx'}/${f.id}`, p);
            }
          },
          p.chatId,
          ac.signal,
        );
        if (!text) await ctl.setContent('（无回复）');
        return text;
      });
      await shareDocs(reply && rewriteFeishuHost(reply), p);
    } catch (err) {
      // 用户已撤回该消息：不再继续回复，幂等跳过该条，避免二次生成/重复发送。
      // 两条路径：a) 生成中收到撤回事件 → abort 触发 Error('aborted')；b) 发送/回复时飞书返回撤回错误码。
      const msg = err instanceof Error ? err.message : String(err);
      const larkErr = err as { code?: string; response?: { data?: { code?: number | string } } };
      if (
        recalledMsgId === p.id
        || /withdrawn/i.test(msg) || /\b230011\b/.test(msg)
        || larkErr.code === 'target_revoked' || larkErr.response?.data?.code === 230011
      ) {
        console.log(`[${bot.id}] 消息已撤回，跳过处理 msg=${p.id}`);
        return;
      }
      console.error(`[${bot.id} message]`, msg);
      if (streamed) return;   // 打字机卡片已带错误尾注
      try {
        const reply = rewriteFeishuHost(await claude.run(p.content, conversationId, undefined, p.chatId));
        await shareDocs(reply, p);
        if (reply) await channel.send(p.chatId, { markdown: reply }, { replyTo: p.id });
      } catch {
        await channel.send(p.chatId, { markdown: '抱歉，处理出错，请稍后再试。' }, { replyTo: p.id });
      }
    } finally {
      if (currentAbort === ac) currentAbort = null;
      if (currentMsgId === p.id) {
        currentMsgId = null;
        if (recalledMsgId === p.id) recalledMsgId = null;
      }
    }
  }

  // 串行消费该 bot 的持久化队列：一次一条，处理完删条；bridge 重启后从文件重放。
  // 单条消息卡死会让 pump 永久挂起、pumping 锁死为 true，后续所有消息只排队不被消费。
  // 加超时兜底：超时即 abort+跳过，保证泵一定前进，不会因一条死消息堵死整队。
  // 1 小时兜底：仅拦截「真·永久挂死」，正常长任务（模型生成长文/查资料）不该被误杀。
  // （撤回导致的 openCard 挂死已在 streamRotate 里根治，这里纯保险。）
  const PER_MSG_TIMEOUT_MS = 60 * 60 * 1000;
  function pumpWithTimeout(msg: PendingMsg): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        currentAbort?.abort();
        console.error(`[${bot.id}] 消息处理超时(${PER_MSG_TIMEOUT_MS / 1000}s)，跳过 msg=${msg.id}`);
        resolve();
      }, PER_MSG_TIMEOUT_MS);
      processOne(msg)
        .catch((err) => console.error(`[${bot.id}] queue 处理异常`, err instanceof Error ? err.message : String(err)))
        .finally(() => { clearTimeout(timer); resolve(); });
    });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pending = loadQueue(bot.id);
        if (pending.length === 0) break;
        if (pending.length <= 2) queueNoticeSent = false;  // 队列消化，重置排队提示
        const msg = pending[0]!;
        await pumpWithTimeout(msg);
        dequeue(bot.id, msg.id);
      }
    } finally {
      pumping = false;
    }
  }

  channel.on('message', async (msg) => {
    const m = msg as unknown as { rawContentType?: string; resources?: Array<{ type?: string }> };
    const image = (m.rawContentType ?? '').toLowerCase() === 'image' || (m.resources ?? []).some((r) => r.type === 'image');
    // 记下「会话 → 用户名」映射，供会话管理展示具体姓名而非 open_id。
    const sid = resolveSessionId({ mode: bot.session_mode, botName: bot.name, userId: msg.senderId, chatId: msg.chatId });
    if (sid) rememberSessionUser(sid, msg.senderId, msg.senderName ?? '');

    // 会话重置指令：清掉本会话文件，下一条消息全新开始（否则按人续聊会让用户
    // 感觉「机器人记着旧账」，只能去面板清）。整条指令消息不进生成队列。
    if (RESET_CMD_RE.test(String(msg.content ?? '').trim())) {
      const ok = sid ? clearSession(bot, sid) : false;
      const text = sid
        ? (ok ? '✅ 已清空会话上下文，下一条消息开始全新对话。' : '当前没有可清空的会话记录。')
        : '当前是逐条新开模式，本来就没有会话上下文。';
      try {
        await channel.send(msg.chatId, { markdown: text }, { replyTo: msg.messageId });
      } catch (err) { console.warn(`[${bot.id}] 重置回复失败`, err instanceof Error ? err.message : String(err)); }
      return;
    }

    // 帮助指令：不进生成队列，直接回能力说明。
    if (HELP_CMD_RE.test(String(msg.content ?? '').trim())) {
      try {
        await channel.send(msg.chatId, { markdown: HELP_TEXT }, { replyTo: msg.messageId });
      } catch (err) { console.warn(`[${bot.id}] help 回复失败`, err instanceof Error ? err.message : String(err)); }
      return;
    }

    // 新用户首条消息：先发一次自我介绍（不拦消息，正常进队列）。
    if (!isIntroduced(bot.id, msg.senderId)) {
      markIntroduced(bot.id, msg.senderId);
      try {
        await channel.send(msg.chatId, { markdown: HELP_TEXT }, { replyTo: msg.messageId });
      } catch (err) { console.warn(`[${bot.id}] 介绍发送失败`, err instanceof Error ? err.message : String(err)); }
    }

    enqueue(bot.id, {
      id: msg.messageId,
      senderId: msg.senderId,
      senderName: msg.senderName ?? '',
      chatId: msg.chatId,
      content: msg.content,
      ts: Date.now(),
      image,
    });
    // 排队去抖：积压超过 2 条时提醒一次（队列消化到 ≤2 条后重置），避免用户等不到
    // 回复就连发（上周实测同一请求连发 4 次）。
    const pending = loadQueue(bot.id);
    if (pending.length > 2 && !queueNoticeSent) {
      queueNoticeSent = true;
      try {
        await channel.send(
          msg.chatId,
          { markdown: `⏳ 你的消息已收到，前面还有 ${pending.length - 1} 条在排队处理（逐条串行回复）。请勿重复发送，稍候即可。` },
          { replyTo: msg.messageId },
        );
      } catch (err) { console.warn(`[${bot.id}] 排队提示失败`, err instanceof Error ? err.message : String(err)); }
    }
    await pump();
  });

  channel.on('error', (err) => {
    const st = running.get(bot.id);
    if (st) st.error = err.message;
    console.error(`[${bot.id} channel]`, err.message);
  });
  channel.on('reject', (evt) => {
    console.warn(`[${bot.id} reject]`, JSON.stringify(evt));
    // 诊断:反查被拒消息的原始 mentions,对比机器人 openId,定位 no_mention 根因。
    void (async () => {
      try {
        const rc = (channel as unknown as { rawClient?: { request: (o: { url: string; method: string }) => Promise<unknown> } }).rawClient;
        const r = await rc?.request({ url: `/open-apis/im/v1/messages/${(evt as { messageId?: string }).messageId}`, method: 'GET' }) as {
          data?: { items?: Array<{ message_type?: string; mentions?: Array<{ key: string; id?: { open_id?: string; user_id?: string } }> }> };
        };
        const it = r?.data?.items?.[0];
        console.log(`[${bot.id} reject-note] type=${it?.message_type} mentions=`, JSON.stringify(it?.mentions));
      } catch (e) { console.error(`[${bot.id} reject-fetch]`, e instanceof Error ? e.message : String(e)); }
    })();
  });
  channel.on('reconnecting', () => console.log(`[${bot.id}] 重连中…`));
  channel.on('reconnected', () => console.log(`[${bot.id}] 已重连`));

  // 主动撤回处理：SDK LarkChannel 的 EventMap 没有 recalled 事件，但底层
  // EventDispatcher.register 就是往 Map 塞 key，直接补注册原始事件
  // im.message.recalled_v1（channel 自己不占用该 key，register 时序无关紧要）。
  const dispatcher = (channel as unknown as {
    dispatcher?: { register: (handlers: Record<string, (raw: unknown) => void>) => unknown };
  }).dispatcher;
  dispatcher?.register({
    'im.message.recalled_v1': (raw) => {
      const messageId = (raw as { message_id?: string }).message_id;
      if (!messageId) return;
      if (currentMsgId === messageId) {
        // 正在生成 → 杀掉 claude 子进程停止打字机；processOne 凭 recalledMsgId 静默跳过。
        // abort 原因 'recalled' 会透传到卡片尾注（「消息已撤回，停止回复」）。
        recalledMsgId = messageId;
        currentAbort?.abort(new Error('recalled'));
        console.log(`[${bot.id}] 消息撤回(生成中)，中止生成 msg=${messageId}`);
        return;
      }
      // 还在队列里排队（注意排除正被处理的队头，它由 abort 路径负责）→ 直接移出。
      if (loadQueue(bot.id).some((x) => x.id === messageId)) {
        dequeue(bot.id, messageId);
        console.log(`[${bot.id}] 消息撤回(排队中)，移出队列 msg=${messageId}`);
      }
      // 已回复完 → 机器人的卡片是独立消息，保留不动。
    },
  });
  return {
    pump,
    abort: () => {
      if (!currentAbort) return false;
      currentAbort.abort();
      return true;
    },
  };
}

export interface BotRunState { status: BotStatus; error: string | null; }

export function statusOf(id: string): BotRunState {
  const st = running.get(id);
  if (!st) return { status: 'stopped', error: null };
  return { status: st.error ? 'error' : 'running', error: st.error || null };
}

export async function startBot(id: string): Promise<BotRunState> {
  // error 残留条目不短路：auto-start 失败后（如启动时出口网络未就绪）允许直接重试，
  // 否则面板点「启动」永远只返回旧错误，必须先 stop 再 start 才能恢复。
  const existing = running.get(id);
  if (existing && !existing.error) return statusOf(id);
  running.delete(id);
  const bot = getBot(id);
  if (!bot) throw new Error('BOT_NOT_FOUND');
  mkdirSync(bot.work_dir, { recursive: true });

  const channel = createLarkChannel({
    appId: bot.feishu.app_id,
    appSecret: bot.feishu.app_secret,
    // 吞掉「no <raw事件> handle」这类无 slot 原始事件的无害告警（如 bot_p2p_chat_entered_v1）。
    logger: silentNoHandleWarn(),
    loggerLevel: LoggerLevel.info,
    policy: bot.feishu.policy,
    outbound: { streamInitialText: bot.feishu.stream_initial_text || '思考中…' },
  });
  const upstream = await resolveUpstreamConfig(bot);
  const claude = createClaudeRunner({
    baseUrl: claudeBaseUrl(bot),
    userKey: bot.memory.user_key,
    binding: bot.binding,
    model: upstream.model,
    name: bot.name,
    workDir: bot.work_dir,
    feishu: bot.feishu,
    systemRules: bot.system_prompt || null,
    sessionMode: bot.session_mode,
  });
  const { pump, abort } = attach(bot, channel, claude, upstream.supportsImages);
  running.set(id, { channel, error: null, abort });
  try {
    await channel.connect();
  } catch (err) {
    running.delete(id);
    try { await channel.disconnect(); } catch { /* ignore */ }
    throw err;
  }
  // 诊断:确认 SDK 是否成功拿到机器人自己的 openId(fetchBotIdentity 失败会静默吞掉,
  // 导致群里 @ 机器人无法被识别为 mentionedBot → 一律 no_mention)。
  const identity = (channel as unknown as { botIdentity?: { openId?: string } }).botIdentity;
  console.log(`[${bot.id}] botIdentity =`, JSON.stringify(identity));
  // 启动后继续处理持久化队列中的未完成消息。
  void pump();
  // 状态一致性：把 enabled 持久化为 true，使进程重启后 startEnabled 会自动拉起，
  // 页面 running 状态与「重启后是否运行」永不脱节。
  updateBot(id, { enabled: true });
  console.log(`[${bot.id}] started bot=${bot.name} session=${SESSION_MODE_LABEL[bot.session_mode]}`);
  return statusOf(id);
}

export async function stopBot(id: string): Promise<BotRunState> {
  const st = running.get(id);
  if (!st) return { status: 'stopped', error: null };
  st.abort?.();
  try {
    await st.channel?.disconnect();
  } catch { /* ignore */ }
  running.delete(id);
  // 状态一致性：停止时持久化 enabled=false，避免进程重启后被 startEnabled 重新拉起
  // （否则会出现「页面显示已停止，重启后却偷偷又在跑」）。
  updateBot(id, { enabled: false });
  return { status: 'stopped', error: null };
}

export async function startEnabled() {
  for (const bot of listBots()) {
    if (!bot.enabled) continue;
    await startWithRetry(bot.id);
  }
}

// auto-start 失败退避重试：容器启动时出口网络/Proxy 可能尚未就绪（如 mihomo-egress 同批启动），
// 直接放弃会让 enabled 机器人一直离线且无自愈。指数退避，最多 5 次约 2 分钟。
async function startWithRetry(id: string, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await startBot(id);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${id}] auto-start failed (attempt ${attempt}/${maxAttempts}):`, msg);
      running.set(id, { channel: null, error: msg });
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  console.error(`[${id}] auto-start gave up after ${maxAttempts} attempts`);
}

// ── 会话管理（面板可查询和控制）─────────────────────────────────────────────
export interface BotSessionState {
  status: BotStatus;
  error: string | null;
  queue: PendingMsg[];
  sessions: SessionMeta[];
}

/** 返回机器人运行态、待处理队列和会话文件信息。 */
export function getBotSessionState(id: string): BotSessionState {
  const bot = getBot(id);
  return { ...statusOf(id), queue: loadQueue(id), sessions: bot ? listBotSessions(bot) : [] };
}

/** 中止机器人当前正在运行的任务。 */
export function abortBotTask(id: string): boolean {
  return running.get(id)?.abort?.() ?? false;
}

/** 删除指定会话文件，使下一轮从新会话开始。 */
export function clearBotSession(id: string, sessionId: string): boolean {
  const bot = getBot(id);
  return bot ? clearSession(bot, sessionId) : false;
}
