import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('./store.js', () => ({
  listBots: () => [],
  getBot: vi.fn(() => null),
  createBot: vi.fn(),
  updateBot: vi.fn(),
  deleteBot: () => false,
  publicBot: (b: unknown) => b,
}));
vi.mock('./runtime.js', () => ({
  startBot: vi.fn(),
  stopBot: vi.fn(),
  statusOf: vi.fn(() => ({ status: 'stopped', error: null })),
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

describe('PUT /api/bots/:id 保存即重启', () => {
  const servers: import('node:http').Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    delete process.env.BRIDGE_ADMIN_TOKEN;
    vi.resetModules();
    vi.clearAllMocks();
  });

  // startServer 内部 resetModules 不会重建 vi.mock 实例——mock 是文件级单例，
  // 上一条测试设置的 mockReturnValue 会泄漏，先 reset 再设。
  async function setup(status: 'running' | 'stopped', bot: Record<string, unknown>) {
    const { server, port } = await startServer('secret-tok');
    servers.push(server);
    const store = await import('./store.js');
    const runtime = await import('./runtime.js');
    vi.resetAllMocks();
    vi.mocked(runtime.statusOf).mockReturnValue({ status, error: null });
    vi.mocked(store.updateBot).mockReturnValue(bot as never);
    vi.mocked(store.getBot).mockReturnValue(bot as never);
    return { port, store, runtime };
  }

  async function putBot(port: number, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/bots/bot-x`, {
      method: 'PUT',
      headers: { 'x-bridge-token': 'secret-tok' },
      body: JSON.stringify(body),
    });
  }

  it('运行中的 bot 保存 → stop 后用新配置 start', async () => {
    const { port, store, runtime } = await setup('running', { id: 'bot-x', enabled: true });
    const res = await putBot(port, { name: '海大' });
    expect(res.status).toBe(200);
    expect(runtime.stopBot).toHaveBeenCalledWith('bot-x');
    expect(store.updateBot).toHaveBeenCalledWith('bot-x', { name: '海大' });
    expect(runtime.startBot).toHaveBeenCalledWith('bot-x');
  });

  it('未运行的 bot 保存 → 不重启', async () => {
    const { port, runtime } = await setup('stopped', { id: 'bot-x', enabled: true });
    const res = await putBot(port, { name: '海大' });
    expect(res.status).toBe(200);
    expect(runtime.stopBot).not.toHaveBeenCalled();
    expect(runtime.startBot).not.toHaveBeenCalled();
  });

  it('保存时 enabled=false → 只停不启', async () => {
    const { port, runtime } = await setup('running', { id: 'bot-x', enabled: false });
    const res = await putBot(port, { enabled: false });
    expect(res.status).toBe(200);
    expect(runtime.stopBot).toHaveBeenCalledWith('bot-x');
    expect(runtime.startBot).not.toHaveBeenCalled();
  });

  it('部分字段 PUT（不带 enabled）且保存前在跑 → 仍重启（stopBot 持久化 enabled=false 不得阻断）', async () => {
    // updateBot/getBot 返回 enabled:false，模拟 stopBot 已把 enabled 写成 false 的落盘状态
    const { port, runtime } = await setup('running', { id: 'bot-x', enabled: false });
    const res = await putBot(port, { name: '海大' });
    expect(res.status).toBe(200);
    expect(runtime.startBot).toHaveBeenCalledWith('bot-x');
  });

  it('重启失败 → 配置仍保存，返回 200 且状态带 error', async () => {
    const { server, port } = await startServer('secret-tok');
    servers.push(server);
    const store = await import('./store.js');
    const runtime = await import('./runtime.js');
    vi.resetAllMocks();
    // 第 1 次：handler 的 wasRunning 判定；第 2 次起：view() 状态。
    vi.mocked(runtime.statusOf)
      .mockReturnValueOnce({ status: 'running', error: null })
      .mockReturnValue({ status: 'error', error: 'connect fail' });
    vi.mocked(store.updateBot).mockReturnValue({ id: 'bot-x', enabled: true } as never);
    vi.mocked(store.getBot).mockReturnValue({ id: 'bot-x', enabled: true } as never);
    vi.mocked(runtime.startBot).mockRejectedValue(new Error('connect fail'));
    const res = await putBot(port, { name: '海大' });
    // 配置已保存、不因重启失败而 500（错误经 statusOf 体现在 view 里，此处 publicBot mock 不带 status，故只断言 code）。
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: 0 });
    expect(store.updateBot).toHaveBeenCalledWith('bot-x', { name: '海大' });
  });
});
