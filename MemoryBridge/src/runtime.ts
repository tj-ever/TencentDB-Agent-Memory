import { mkdirSync } from 'node:fs';
import { createLarkChannel, LoggerLevel, type LarkChannel } from '@larksuiteoapi/node-sdk';
import { createClaudeRunner, type ClaudeRunner } from './claudeRunner.js';
import { extractDriveFiles, openDocsFromText, rewriteFeishuHost } from './docShare.js';
import { runWithRotatingMarkdown } from './streamRotate.js';
import { SESSION_MODE_LABEL } from './sessionMode.js';
import { getBot, listBots, type Bot, type BotStatus } from './store.js';

const running = new Map<string, { channel: LarkChannel | null; error: string | null }>();

function claudeBaseUrl(bot: Bot): string {
  return `${bot.memory.proxy_base_url.replace(/\/$/, '')}/claude-code/${bot.memory.space_id}`;
}

function attach(bot: Bot, channel: LarkChannel, claude: ClaudeRunner) {
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

  channel.on('message', async (msg) => {
    const conversationId = msg.senderId;   // 飞书用户 -> 记忆按用户隔离
    console.log(`[${bot.id} ->] ${msg.messageId} user=${msg.senderId}`);
    let streamed = false;
    try {
      const reply = await runWithRotatingMarkdown(channel, msg.chatId, { replyTo: msg.messageId }, async (ctl) => {
        streamed = true;
        const seenShare = new Set<string>();
        let streamedText = '';
        const text = await claude.run(
          msg.content,
          conversationId,
          async (chunk) => {
            const out = rewriteFeishuHost(chunk);
            streamedText += out;
            await ctl.append(out);
            // 链接一出现就提权，避免打字机里先点到 tenant_readable / 错域名
            const fresh = extractDriveFiles(streamedText).filter((f) => !seenShare.has(f.id));
            for (const f of fresh) {
              seenShare.add(f.id);
              await shareDocs(`https://www.feishu.cn/${f.type === 'sheet' ? 'sheets' : 'docx'}/${f.id}`, msg);
            }
          },
          msg.chatId,
          ctl.signal,
        );
        if (!text) await ctl.setContent('（无回复）');
        return text;
      });
      await shareDocs(reply && rewriteFeishuHost(reply), msg);
    } catch (err) {
      console.error(`[${bot.id} message]`, err instanceof Error ? err.message : String(err));
      if (streamed) return;   // 打字机卡片已带错误尾注
      try {
        const reply = rewriteFeishuHost(await claude.run(msg.content, conversationId, undefined, msg.chatId));
        await shareDocs(reply, msg);
        if (reply) await channel.send(msg.chatId, { markdown: reply }, { replyTo: msg.messageId });
      } catch {
        await channel.send(msg.chatId, { markdown: '抱歉，处理出错，请稍后再试。' }, { replyTo: msg.messageId });
      }
    }
  });

  channel.on('error', (err) => {
    const st = running.get(bot.id);
    if (st) st.error = err.message;
    console.error(`[${bot.id} channel]`, err.message);
  });
  channel.on('reject', (evt) => console.warn(`[${bot.id} reject]`, JSON.stringify(evt)));
  channel.on('reconnecting', () => console.log(`[${bot.id}] 重连中…`));
  channel.on('reconnected', () => console.log(`[${bot.id}] 已重连`));
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
    loggerLevel: LoggerLevel.info,
    policy: bot.feishu.policy,
    outbound: { streamInitialText: bot.feishu.stream_initial_text || '思考中…' },
  });
  const claude = createClaudeRunner({
    baseUrl: claudeBaseUrl(bot),
    userKey: bot.memory.user_key,
    binding: bot.binding,
    model: bot.llm.model || 'grok-4.6',
    name: bot.name,
    workDir: bot.work_dir,
    feishu: bot.feishu,
    systemRules: bot.system_prompt || null,
    sessionMode: bot.session_mode,
  });
  attach(bot, channel, claude);
  running.set(id, { channel, error: null });
  try {
    await channel.connect();
  } catch (err) {
    running.delete(id);
    try { await channel.disconnect(); } catch { /* ignore */ }
    throw err;
  }
  console.log(`[${bot.id}] started bot=${bot.name} session=${SESSION_MODE_LABEL[bot.session_mode]}`);
  return statusOf(id);
}

export async function stopBot(id: string): Promise<BotRunState> {
  const st = running.get(id);
  if (!st) return { status: 'stopped', error: null };
  try {
    await st.channel?.disconnect();
  } catch { /* ignore */ }
  running.delete(id);
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
