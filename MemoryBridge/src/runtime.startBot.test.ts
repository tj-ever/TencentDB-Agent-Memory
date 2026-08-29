// 验证机器人启动恢复逻辑：auto-start 失败留下的 error 残留条目不得阻塞重试
// （对应故障：容器启动时出口网络未就绪 → startBot 失败 → 之后 start 永远返回旧错误）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const connectMock = vi.fn<() => Promise<void>>();

vi.mock('@larksuiteoapi/node-sdk', () => ({
  createLarkChannel: vi.fn(() => ({
    connect: connectMock,
    disconnect: vi.fn(),
    on: vi.fn(),
  })),
  defaultLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  LoggerLevel: { info: 1 },
}));
vi.mock('./claudeRunner.js', () => ({ createClaudeRunner: vi.fn(() => ({})) }));
vi.mock('./docShare.js', () => ({
  extractDriveFiles: vi.fn(() => []),
  openDocsFromText: vi.fn(async () => []),
  rewriteFeishuHost: vi.fn((s: string) => s),
}));
vi.mock('./streamRotate.js', () => ({ runWithRotatingMarkdown: vi.fn() }));
vi.mock('./sessionMode.js', () => ({
  resolveSessionId: vi.fn(() => 's1'),
  SESSION_MODE_LABEL: { none: '逐条新开' },
}));
vi.mock('./store.js', () => ({
  getBot: vi.fn(() => ({
    id: 'b1', name: 't', work_dir: '/tmp/b1-test', enabled: true,
    memory: { proxy_base_url: 'http://x', space_id: 'default', user_key: 'k' },
    binding: {}, feishu: { app_id: 'a', app_secret: 's', policy: {} },
    session_mode: 'none', system_prompt: null,
  })),
  listBots: vi.fn(() => []),
  updateBot: vi.fn(),
}));
vi.mock('./messageQueue.js', () => ({
  enqueue: vi.fn(), dequeue: vi.fn(), loadQueue: vi.fn(() => []),
}));
vi.mock('./sessionManager.js', () => ({
  clearBotSession: vi.fn(() => true),
  listBotSessions: vi.fn(() => []),
  rememberSessionUser: vi.fn(),
}));
// resolveUpstreamConfig 里 fetch Proxy；mock 掉网络。
vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true, json: async () => ({ model: 'm1', supportsImages: false }),
})));

const { startBot } = await import('./runtime.js');

describe('startBot 错误残留恢复', () => {
  beforeEach(() => { connectMock.mockReset(); });

  it('失败后再次 start 应重连，而不是返回旧错误', async () => {
    // 第一次：连接失败（模拟出口网络未就绪）
    connectMock.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(startBot('b1')).rejects.toThrow('fetch failed');

    // 第二次：网络恢复 → 不应被 error 残留条目短路
    connectMock.mockResolvedValueOnce(undefined);
    const st = await startBot('b1');
    expect(st.status).toBe('running');
    expect(st.error).toBeNull();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});
