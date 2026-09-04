import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listBots, getBot, createBot, updateBot, deleteBot, publicBot, type Bot, type BotInput } from './store.js';
import { startBot, stopBot, statusOf, getBotSessionState, abortBotTask, clearBotSession } from './runtime.js';

// 管理 API 门禁：设置 BRIDGE_ADMIN_TOKEN 后，除 /health 外全部要求 x-bridge-token 匹配。
// 不设时放行并告警（本地裸跑开发场景）；部署脚本会生成 .bridge-token 并注入两容器。
// 注：浏览器从不直连 bridge（面板走服务端反代），故无 CORS 头。
const ADMIN_TOKEN = process.env.BRIDGE_ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) {
  console.warn('[http] BRIDGE_ADMIN_TOKEN 未设置，管理 API 处于无鉴权状态（仅限本地开发）');
}

function authorized(req: IncomingMessage): boolean {
  if (!ADMIN_TOKEN) return true;
  return req.headers['x-bridge-token'] === ADMIN_TOKEN;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function envelope(res: ServerResponse, status: number, code: number, message: string, data: unknown) {
  send(res, status, { code, message, request_id: '', data });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function view(bot: Bot) {
  const { status, error } = statusOf(bot.id);
  return publicBot(bot, status, error);
}

export function createBridgeServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/health') {
      return send(res, 200, { ok: true, service: 'memory-bridge' });
    }

    if (!authorized(req)) return send(res, 401, { code: 401, message: 'unauthorized', request_id: '', data: null });

    try {
      if (req.method === 'GET' && pathname === '/api/bots') {
        const teamId = url.searchParams.get('team_id');
        let bots = listBots();
        if (teamId) bots = bots.filter((b) => b.binding.team_id === teamId);
        return envelope(res, 200, 0, 'ok', bots.map(view));
      }

      const one = pathname.match(/^\/api\/bots\/([^/]+)$/);
      const action = pathname.match(/^\/api\/bots\/([^/]+)\/(start|stop)$/);
      const sessions = pathname.match(/^\/api\/bots\/([^/]+)\/sessions$/);
      const clearSession = pathname.match(/^\/api\/bots\/([^/]+)\/sessions\/([^/]+)\/clear$/);
      const abort = pathname.match(/^\/api\/bots\/([^/]+)\/abort$/);

      if (req.method === 'POST' && pathname === '/api/bots') {
        const bot = createBot(await readBody(req) as BotInput);
        return envelope(res, 200, 0, 'ok', view(bot));
      }

      if (one && req.method === 'GET') {
        const bot = getBot(decodeURIComponent(one[1]!));
        if (!bot) return envelope(res, 404, 404, 'BOT_NOT_FOUND', null);
        return envelope(res, 200, 0, 'ok', view(bot));
      }

      if (one && req.method === 'PUT') {
        const id = decodeURIComponent(one[1]!);
        // 保存即生效：运行中的 bot 改配置后自动重启，否则 WS 还握着旧凭证，新 app 的消息进不来。
        const wasRunning = statusOf(id).status === 'running';
        if (wasRunning) await stopBot(id);
        const bot = updateBot(id, await readBody(req) as BotInput);
        if (!bot) return envelope(res, 404, 404, 'BOT_NOT_FOUND', null);
        if (wasRunning && bot.enabled) {
          try { await startBot(id); }
          catch (err) { console.error(`[${id}] 保存后自动重启失败(配置已保存):`, err instanceof Error ? err.message : String(err)); }
        }
        return envelope(res, 200, 0, 'ok', view(getBot(id)!));
      }

      if (one && req.method === 'DELETE') {
        const id = decodeURIComponent(one[1]!);
        await stopBot(id);
        if (!deleteBot(id)) return envelope(res, 404, 404, 'BOT_NOT_FOUND', null);
        return envelope(res, 200, 0, 'ok', { ok: true });
      }

      if (action && req.method === 'POST') {
        const id = decodeURIComponent(action[1]!);
        const bot = getBot(id);
        if (!bot) return envelope(res, 404, 404, 'BOT_NOT_FOUND', null);
        if (action[2] === 'start') await startBot(id);
        else await stopBot(id);
        return envelope(res, 200, 0, 'ok', view(getBot(id)!));
      }

      // ── 会话管理（面板）──────────────────────────────────────────
      if (sessions && req.method === 'GET') {
        const id = decodeURIComponent(sessions[1]!);
        if (!getBot(id)) return envelope(res, 404, 404, 'BOT_NOT_FOUND', null);
        return envelope(res, 200, 0, 'ok', getBotSessionState(id));
      }
      if (clearSession && req.method === 'POST') {
        const [, id, sid] = clearSession;
        const botId = decodeURIComponent(id!);
        if (!getBot(botId)) return envelope(res, 404, 404, 'BOT_NOT_FOUND', null);
        const ok = clearBotSession(botId, decodeURIComponent(sid!));
        return envelope(res, 200, 0, 'ok', { ok, sessionId: decodeURIComponent(sid!) });
      }
      if (abort && req.method === 'POST') {
        const botId = decodeURIComponent(abort[1]!);
        if (!getBot(botId)) return envelope(res, 404, 404, 'BOT_NOT_FOUND', null);
        return envelope(res, 200, 0, 'ok', { ok: abortBotTask(botId) });
      }

      envelope(res, 404, 404, 'NOT_FOUND', null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg === 'BOT_NOT_FOUND' ? 404 : 400;
      envelope(res, code, code, msg, null);
    }
  });
}
