/**
 * 每个机器人使用一条持久化待处理消息队列。
 * 消息先写入 `<data>/pending/<botId>.jsonl`，处理完成后删除；进程重启时继续消费文件中的消息。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.BRIDGE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const PENDING_DIR = join(DATA_DIR, 'pending');
mkdirSync(PENDING_DIR, { recursive: true });

export interface PendingMsg {
  id: string;              // 飞书 messageId
  senderId: string;
  senderName?: string;
  chatId: string;
  content: string;
  ts: number;
  /** 是否为图片消息（文本模型不支持识图时直接拒绝）。 */
  image?: boolean;
}

function queueFile(botId: string): string {
  return join(PENDING_DIR, `${botId}.jsonl`);
}

/** 按写入顺序读取机器人的待处理消息。 */
export function loadQueue(botId: string): PendingMsg[] {
  const f = queueFile(botId);
  try {
    const lines = readFileSync(f, 'utf-8').split('\n').filter(Boolean);
    const out: PendingMsg[] = [];
    for (const L of lines) {
      try { out.push(JSON.parse(L) as PendingMsg); } catch { /* 跳过损坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** 追加一条待处理消息并立即落盘。 */
export function enqueue(botId: string, item: PendingMsg): void {
  writeFileSync(queueFile(botId), JSON.stringify(item) + '\n', { flag: 'a' });
}

/** 删除指定消息并原子重写队列文件。 */
export function dequeue(botId: string, id: string): void {
  const item = loadQueue(botId).filter((x) => x.id !== id);
  const f = queueFile(botId);
  if (item.length === 0) {
    try { unlinkSync(f); } catch { /* 已为空 */ }
    return;
  }
  const temp = `${f}.${process.pid}.tmp`;
  writeFileSync(temp, item.map((x) => JSON.stringify(x)).join('\n') + '\n');
  renameSync(temp, f);
}
