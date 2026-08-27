import { mkdirSync } from 'node:fs';
import { createLarkChannel, defaultLogger, LoggerLevel, type LarkChannel } from '@larksuiteoapi/node-sdk';
import { createClaudeRunner, type ClaudeRunner } from './claudeRunner.js';
import { extractDriveFiles, openDocsFromText, rewriteFeishuHost } from './docShare.js';
import { runWithRotatingMarkdown } from './streamRotate.js';
import { resolveSessionId, SESSION_MODE_LABEL } from './sessionMode.js';
import { getBot, listBots, updateBot, type Bot, type BotStatus } from './store.js';
import { enqueue, dequeue, loadQueue, type PendingMsg } from './messageQueue.js';
import { clearBotSession as clearSession, listBotSessions, rememberSessionUser, type SessionMeta } from './sessionManager.js';

const running = new Map<string, { channel: LarkChannel | null; error: string | null; abort?: () => boolean }>();

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
              await shareDocs(`https://www.feishu.cn/${f.type === 'sheet' ? 'sheets' : 'docx'}/${f.id}`, p);
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
      const msg = err instanceof Error ? err.message : String(err);
      const larkErr = err as { code?: string; response?: { data?: { code?: number | string } } };
      if (/withdrawn/i.test(msg) || /\b230011\b/.test(msg) || larkErr.code === 'target_revoked' || larkErr.response?.data?.code === 230011) {
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
    }
  }

  // 串行消费该 bot 的持久化队列：一次一条，处理完删条；bridge 重启后从文件重放。
  // 单条消息卡死（如回复目标已被撤回导致流式 pending 永不 settle）会让 pump 永久挂起、
  // pumping 锁死为 true，后续所有消息只排队不被消费。加超时兜底：超时即 abort+跳过，
  // 保证泵一定前进，不会因一条死消息堵死整队。
  // 1 小时兜底：仅拦截「真·永久挂死」（回复目标被撤回等导致 promise 永不 settle），
  // 正常长任务（模型生成长文/查资料）不该被误杀。
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
    enqueue(bot.id, {
      id: msg.messageId,
      senderId: msg.senderId,
      senderName: msg.senderName ?? '',
      chatId: msg.chatId,
      content: msg.content,
      ts: Date.now(),
      image,
    });
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
  const existing = running.get(id);
  if (existing) return statusOf(id);
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
    try {
      await startBot(bot.id);
    } catch (err) {
      console.error(`[${bot.id}] auto-start failed:`, err instanceof Error ? err.message : String(err));
      running.set(bot.id, { channel: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
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
