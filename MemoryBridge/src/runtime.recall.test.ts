// 撤回处理测试：
// 1. streamRotate.openCard 在回复目标被撤回时必须立刻失败（此前永久挂死，只能靠 1h 泵超时兜底）；
// 2. attach 注册的 im.message.recalled_v1 事件：排队中 → 移出队列；生成中 → abort。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// on('message') 捕获 + streamRotate mock 的放行闸门，需要在 vi.mock 工厂（hoisted）里共享。
const h = vi.hoisted(() => ({
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  gate: null as null | (() => void),
}));

// ── streamRotate.openCard 挂死回归（真模块，绕过全局 mock）─────────────────
describe('openCard 撤回挂死回归', () => {
  it('stream 在 producer 前 reject → runWithRotatingMarkdown 立刻失败，不挂死', async () => {
    const { runWithRotatingMarkdown } = await vi.importActual<typeof import('./streamRotate.js')>('./streamRotate.js');
    // channel.stream 在 producer 被调用前直接 reject（撤回场景 230011）。
    const channel = {
      stream: () => Promise.reject(new Error('msg has been withdrawn, code 230011')),
    } as unknown as Parameters<typeof runWithRotatingMarkdown>[0];
    let workStarted = false;
    await expect(
      runWithRotatingMarkdown(channel, 'oc_1', { replyTo: 'om_gone' }, async () => {
        workStarted = true;
        return 'unused';
      }, { rotateMs: 60_000 }),
    ).rejects.toThrow(/230011|withdrawn/);
    expect(workStarted).toBe(false); // 生成未开始 → 不浪费上游 token
  });
});

// ── 中止尾注（真模块）：撤回/普通中止写对应说明，而非「处理失败」或 SDK 的 "(no content)" ──
describe('中止尾注', () => {
  it.each([
    ['recalled', '消息已撤回'],
    ['aborted', '已停止生成'],
  ])('work 抛 %s → 卡片写对应说明', async (kind, expectText) => {
    const { runWithRotatingMarkdown } = await vi.importActual<typeof import('./streamRotate.js')>('./streamRotate.js');
    const append = vi.fn(async () => {});
    const ctl = { append, setContent: vi.fn(async () => {}) };
    // 卡片常驻：markdown 回调挂起直到 runWithRotatingMarkdown 的 finally 放行。
    const channel = {
      stream: (_to: unknown, input: { markdown: (c: unknown) => Promise<void> }) => input.markdown(ctl),
    } as unknown as Parameters<typeof runWithRotatingMarkdown>[0];
    const p = runWithRotatingMarkdown(channel, 'oc_1', undefined, async () => {
      throw new Error(kind);
    }, { rotateMs: 60_000 });
    await expect(p).rejects.toThrow(kind);
    expect(append).toHaveBeenCalledWith(expect.stringContaining(expectText));
    expect(append).not.toHaveBeenCalledWith(expect.stringContaining('处理失败'));
  });
});

// ── 撤回事件三分支（经由真实 startBot → attach 装配）──────────────────────
const connectMock = vi.fn<() => Promise<void>>();
const enqueue = vi.fn();
const dequeue = vi.fn();
const loadQueue = vi.fn((): Array<{ id: string }> => []);
let recallHandler: ((raw: unknown) => void) | undefined;

vi.mock('@larksuiteoapi/node-sdk', () => ({
  createLarkChannel: vi.fn(() => ({
    connect: connectMock,
    disconnect: vi.fn(),
    on: (ev: string, fn: (...args: unknown[]) => unknown) => { h.onHandlers.set(ev, fn); },
    // attach 在底层 dispatcher 上补注册撤回事件；channel 不占用该 key。
    dispatcher: {
      register: (handlers: Record<string, (raw: unknown) => void>) => {
        recallHandler = handlers['im.message.recalled_v1'];
      },
    },
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
// mock 成「永不结束的生成」，用 gate 手动放行以制造「生成中」窗口。
vi.mock('./streamRotate.js', () => ({
  runWithRotatingMarkdown: vi.fn(async (_ch: unknown, _to: unknown, _opts: unknown, work: () => unknown) => {
    await new Promise<void>((r) => { h.gate = r; });
    return work;
  }),
}));
vi.mock('./sessionMode.js', () => ({
  resolveSessionId: vi.fn(() => 's1'),
  SESSION_MODE_LABEL: { none: '逐条新开' },
}));
vi.mock('./store.js', () => ({
  getBot: vi.fn(() => ({
    id: 'b1', name: 't', work_dir: '/tmp/b1-recall-test', enabled: true,
    memory: { proxy_base_url: 'http://x', space_id: 'default', user_key: 'k' },
    binding: {}, feishu: { app_id: 'a', app_secret: 's', policy: {} },
    session_mode: 'none', system_prompt: null,
  })),
  listBots: vi.fn(() => []),
  updateBot: vi.fn(),
}));
vi.mock('./messageQueue.js', () => ({ enqueue, dequeue, loadQueue }));
vi.mock('./sessionManager.js', () => ({
  clearBotSession: vi.fn(() => true),
  listBotSessions: vi.fn(() => []),
  rememberSessionUser: vi.fn(),
}));
vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true, json: async () => ({ model: 'm1', supportsImages: false }),
})));

describe('im.message.recalled_v1 三分支', () => {
  let dataDir: string;
  let queue: Array<{ id: string }>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();          // 每个用例全新 runtime 实例（running Map 不跨用例残留）
    dataDir = mkdtempSync(join(tmpdir(), 'recall-'));
    process.env.BRIDGE_DATA_DIR = dataDir;
    connectMock.mockReset().mockResolvedValue(undefined);
    enqueue.mockClear();
    dequeue.mockReset();
    queue = [];
    loadQueue.mockReset().mockImplementation(() => queue.slice());
    dequeue.mockImplementation((_bot: string, id: string) => {
      const i = queue.findIndex((x) => x.id === id);
      if (i >= 0) queue.splice(i, 1);
    });
    h.onHandlers.clear();
    h.gate = null;
    recallHandler = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boot() {
    const { startBot } = await import('./runtime.js');
    await startBot('b1');
  }

  it('attach 时在 dispatcher 上注册了撤回事件', async () => {
    await boot();
    expect(typeof recallHandler).toBe('function');
  });

  it('排队中的消息被撤回 → 移出队列', async () => {
    await boot();
    queue = [{ id: 'om_q' }];
    recallHandler!({ message_id: 'om_q' });
    expect(dequeue).toHaveBeenCalledWith('b1', 'om_q');
    expect(queue).toEqual([]);
  });

  it('生成中的消息被撤回 → 走 abort 分支（不抢泵的 dequeue）', async () => {
    await boot();
    const msgHandler = h.onHandlers.get('message')!;
    queue = [{ id: 'om_run' }];
    msgHandler({ messageId: 'om_run', senderId: 'ou_1', senderName: 'u', chatId: 'oc_1', content: 'hi' });
    await vi.waitFor(() => expect(h.gate).toBeTruthy());      // 已进入「生成中」
    recallHandler!({ message_id: 'om_run' });
    expect(dequeue).not.toHaveBeenCalled();                    // 队头交给 pump 收尾删除
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('中止生成'));
    h.gate!();                                                 // 放行，让泵走完
    await vi.waitFor(() => expect(queue).toEqual([]));
  });

  it('已处理完/未知消息、畸形事件 → 无动作不抛错', async () => {
    await boot();
    recallHandler!({ message_id: 'om_gone' });
    expect(dequeue).not.toHaveBeenCalled();
    expect(() => recallHandler!({})).not.toThrow();
  });
});
