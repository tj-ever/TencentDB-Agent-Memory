import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('./store.js', () => ({
  listBots: () => [],
  getBot: () => null,
  createBot: vi.fn(),
  updateBot: vi.fn(),
  deleteBot: () => false,
  publicBot: (b: unknown) => b,
}));
vi.mock('./runtime.js', () => ({
  startBot: vi.fn(),
  stopBot: vi.fn(),
  statusOf: () => ({ status: 'stopped', error: null }),
  getBotSessionState: vi.fn(),
  abortBotTask: vi.fn(),
  clearBotSession: vi.fn(),
}));

// ADMIN_TOKEN 在模块加载时读 env，resetModules 后动态 import 以测不同配置。
async function startServer(token: string): Promise<{ server: import('node:http').Server; port: number }> {
  vi.resetModules();
  process.env.BRIDGE_ADMIN_TOKEN = token;
  const { createBridgeServer } = await import('./http.js');
  const server = createBridgeServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return { server, port: addr.port };
}

describe('bridge http 管理 API token 门禁', () => {
  const servers: import('node:http').Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    delete process.env.BRIDGE_ADMIN_TOKEN;
    vi.resetModules();
  });

  it('无 token / 错 token → 401', async () => {
    const { server, port } = await startServer('secret-tok');
    servers.push(server);
    expect((await fetch(`http://127.0.0.1:${port}/api/bots`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/bots`, { headers: { 'x-bridge-token': 'wrong' } })).status).toBe(401);
  });

  it('正确 token → 200', async () => {
    const { server, port } = await startServer('secret-tok');
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/bots`, { headers: { 'x-bridge-token': 'secret-tok' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: 0 });
  });

  it('/health 免鉴权（docker healthcheck 依赖）', async () => {
    const { server, port } = await startServer('secret-tok');
    servers.push(server);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });

  it('未配置 token → 放行（本地开发兼容）', async () => {
    const { server, port } = await startServer('');
    servers.push(server);
    expect((await fetch(`http://127.0.0.1:${port}/api/bots`)).status).toBe(200);
  });
});
