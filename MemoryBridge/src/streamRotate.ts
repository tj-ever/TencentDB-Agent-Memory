// 飞书单张流式卡片约 10 分钟关流。9:30 收掉当前卡；有后续字再开一张（续）。
import type { LarkChannel, MarkdownStreamController, SendOptions } from '@larksuiteoapi/node-sdk';

export const STREAM_ROTATE_MS = 9 * 60 * 1000 + 30 * 1000;

interface RotateOpts {
  rotateMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
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
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }: RotateOpts = {},
): Promise<T> {
  const ac = new AbortController();
  let ctl: MarkdownStreamController | null = null;
  let release: (() => void) | null = null;
  let streamDone: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
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
    append: (chunk) => enqueue(() => withCard(chunk, (c, text) => c.append(text))),
    setContent: (full) => enqueue(() => withCard(full, (c, text) => c.setContent(text))),
  };

  try {
    return await work(wrapper);
  } catch (err) {
    // 中止（撤回/面板 abort）不是失败：卡片停在已生成内容上正常收尾，不写错误尾注。
    const aborted = err instanceof Error && err.message === 'aborted';
    await enqueue(async () => {
      try {
        if (!ctl) await openCard();
        await ctl?.append(aborted ? '' : '\n\n_处理失败，请稍后再试。_');
      } catch { /* ignore */ }
    });
    throw err;
  } finally {
    finished = true;
    if (timer) clearTimer(timer);
    await enqueue(async () => {
      if (release) release();
      if (streamDone) await streamDone.catch(() => {});
    });
  }
}
