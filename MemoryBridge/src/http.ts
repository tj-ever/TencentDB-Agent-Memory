import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listBots, getBot, createBot, updateBot, deleteBot, publicBot, type Bot, type BotInput } from './store.js';
import { startBot, stopBot, statusOf } from './runtime.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-tdai-service-id, x-tdai-user-key',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS });
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
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { pathname } = url;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, { ok: true, service: 'memory-bridge' });
      }

      if (req.method === 'GET' && pathname === '/api/bots') {
        const teamId = url.searchParams.get('team_id');
        let bots = listBots();
        if (teamId) bots = bots.filter((b) => b.binding.team_id === teamId);
        return envelope(res, 200, 0, 'ok', bots.map(view));
      }

      const one = pathname.match(/^\/api\/bots\/([^/]+)$/);
      const action = pathname.match(/^\/api\/bots\/([^/]+)\/(start|stop)$/);

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
        const bot = updateBot(decodeURIComponent(one[1]!), await readBody(req) as BotInput);
        if (!bot) return envelope(res, 404, 404, 'BOT_NOT_FOUND', null);
        return envelope(res, 200, 0, 'ok', view(bot));
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

      envelope(res, 404, 404, 'NOT_FOUND', null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg === 'BOT_NOT_FOUND' ? 404 : 400;
      envelope(res, code, code, msg, null);
    }
  });
}
