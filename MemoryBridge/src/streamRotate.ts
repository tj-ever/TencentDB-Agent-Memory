// 飞书单张流式卡片约 10 分钟关流。9:30 收掉当前卡；有后续字再开一张（续）。
// 长任务心跳：HEARTBEAT_MS 无增量时往卡片补一行运行时长，让用户知道还在干活。
import type { LarkChannel, MarkdownStreamController, SendOptions } from '@larksuiteoapi/node-sdk';

export const STREAM_ROTATE_MS = 9 * 60 * 1000 + 30 * 1000;
export const HEARTBEAT_MS = 5 * 60 * 1000;

interface RotateOpts {
  rotateMs?: number;
  heartbeatMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}

export interface StreamCtl {
  signal: AbortSignal;
  append: (chunk: string) => Promise<unknown>;
  setContent: (full: string) => Promise<unknown>;
}

export async function runWithRotatingMarkdown<T>(
  channel: LarkChannel,
  to: string,
  opts: SendOptions | undefined,
  work: (ctl: StreamCtl) => Promise<T>,
  {
    rotateMs = STREAM_ROTATE_MS,
    heartbeatMs = HEARTBEAT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
  }: RotateOpts = {},
): Promise<T> {
  const ac = new AbortController();
  let ctl: MarkdownStreamController | null = null;
  let release: (() => void) | null = null;
  let streamDone: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hbTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAppend = now();
  let finished = false;
  let gate: Promise<unknown> = Promise.resolve();
  let cards = 0;

  function enqueue(fn: () => Promise<unknown>): Promise<unknown> {
    const run = gate.then(fn, fn);
    gate = run.catch(() => {});
    return run;
  }

  function armTimer() {
    timer = setTimer(() => {
      enqueue(() => rotate()).catch((err: Error) => {
        console.error('[stream-rotate]', err.message);
        ac.abort();
      });
    }, rotateMs);
  }

  // 心跳：距上一次真实增量超过 heartbeatMs 就补一行运行时长。
  // 走 withCard 而非裸 ctl.append——卡片可能刚好在轮换窗口（ctl=null），
  // 且轮换计数必须同步更新，否则会把心跳写进已关闭的流。
  function armHeartbeat() {
    hbTimer = setTimer(() => {
      hbTimer = null;
      if (finished || ac.signal.aborted) return;
      const idle = now() - lastAppend;
      if (idle < heartbeatMs) { armHeartbeat(); return; }
      const mins = Math.round((now() - start) / 60000);
      enqueue(() => withCard(`\n\n_⏳ 已运行 ${mins} 分钟，仍在生成中…_\n\n`, (c, text) => c.append(text)))
        .then(() => { if (!finished) armHeartbeat(); })
        .catch(() => { /* 心跳失败不致命 */ });
    }, heartbeatMs - (now() - lastAppend));
  }

  const start = now();

  async function openCard() {
    let ready!: () => void;
    const readyP = new Promise<void>((r) => { ready = r; });
    streamDone = channel.stream(to, {
      markdown: async (c) => {
        ctl = c;
        ready();
        await new Promise<void>((r) => { release = r; });
      },
    }, opts);
    // 回复目标已被撤回时 stream() 会在调用 producer 前直接 reject（code 230011），
    // ready 永不触发——必须和 streamDone 竞速，否则这里永久挂死（只能靠 1h 泵超时兜底）。
    // race 一旦失败即抛撤回错误：初次 openCard 发生在 work() 之前，
    // 让整条消息在 claude 生成开始前就失败退出，不浪费上游 token。
    await Promise.race([readyP, streamDone]);
    if (!ctl) throw new Error('stream open failed');
    cards += 1;
    armTimer();
    if (cards === 1) armHeartbeat();
  }

  async function rotate() {
    if (finished || ac.signal.aborted) return;
    if (timer) clearTimer(timer);
    timer = null;
    if (release) release();
    release = null;
    ctl = null;
    if (streamDone) await streamDone;
    streamDone = null;
  }

  async function withCard(chunk: string, write: (c: MarkdownStreamController, text: string) => Promise<void>) {
    if (finished || ac.signal.aborted) return;
    if (!ctl) {
      await openCard();
      if (cards > 1) {
        console.log(`[stream-rotate] 第${cards}张打字机`);
        chunk = `（续）\n\n${chunk}`;
      }
    }
    await write(ctl!, chunk);
  }

  await openCard();

  const wrapper: StreamCtl = {
    signal: ac.signal,
    append: (chunk) => {
      lastAppend = now();
      return enqueue(() => withCard(chunk, (c, text) => c.append(text)));
    },
    setContent: (full) => {
      lastAppend = now();
      return enqueue(() => withCard(full, (c, text) => c.setContent(text)));
    },
  };

  try {
    return await work(wrapper);
  } catch (err) {
    // 中止（撤回/面板 abort）不是失败：卡片停在已生成内容上，写一行说明而非错误尾注。
    // 说明必须非空——零内容收尾时 SDK 会把卡片打成 "(no content)" 占位。
    const kind = err instanceof Error ? err.message : '';
    const tail = kind === 'recalled' ? '\n\n_（消息已撤回，停止回复）_'
      : kind === 'aborted' ? '\n\n_（已停止生成）_'
      : '\n\n_处理失败，请稍后再试。_';
    await enqueue(async () => {
      try {
        if (!ctl) await openCard();
        await ctl?.append(tail);
      } catch { /* ignore */ }
    });
    throw err;
  } finally {
    finished = true;
    if (timer) clearTimer(timer);
    if (hbTimer) clearTimer(hbTimer);
    await enqueue(async () => {
      if (release) release();
      if (streamDone) await streamDone.catch(() => {});
    });
  }
}
