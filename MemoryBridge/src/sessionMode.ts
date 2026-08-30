// Claude 会话模式：none 逐条新开 / user 按人续聊 / chat 按群续聊。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SessionMode = 'none' | 'user' | 'chat';

export const SESSION_MODE_LABEL: Record<SessionMode, string> = {
  none: '逐条新开',
  user: '按人续聊',
  chat: '按群续聊',
};

const ALIAS: Record<string, SessionMode> = {
  '1': 'none',
  '2': 'user',
  '3': 'chat',
  fresh: 'none',
  'per-user': 'user',
  'per-chat': 'chat',
};

export function parseSessionMode(raw: unknown): SessionMode {
  const v = String(raw ?? 'none').trim().toLowerCase();
  const mode = (ALIAS[v] ?? v) as SessionMode;
  if (!SESSION_MODE_LABEL[mode]) {
    throw new Error(`session_mode 无效: ${String(raw)}，应为 none | user | chat`);
  }
  return mode;
}

const NS = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');

export function sessionUuid(seed: string): string {
  const h = createHash('sha1').update(NS).update(String(seed)).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// Claude Code 把 cwd 里所有非字母数字字符替换为 '-'（实测 ~/.claude/projects/ 下的
// 目录名：'.'、'_'、空格同样被替换），必须与之逐字符一致才能命中会话文件。
export function projectSlug(workDir: string): string {
  return String(workDir).replace(/[^a-zA-Z0-9]/g, '-');
}

export function sessionFilePath(workDir: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', projectSlug(workDir), `${sessionId}.jsonl`);
}

export function sessionExists(workDir: string, sessionId: string): boolean {
  return existsSync(sessionFilePath(workDir, sessionId));
}

export interface SessionSeed {
  mode: SessionMode;
  botName: string;
  userId: string;
  chatId?: string;
}

export function resolveSessionId({ mode, botName, userId, chatId }: SessionSeed): string | null {
  if (mode === 'none') return null;
  const id = mode === 'chat' ? (chatId || userId) : userId;
  if (!id) return null;
  return sessionUuid(`${botName}:${mode}:${id}`);
}

export function sessionArgv(workDir: string, sessionId: string | null, exists = sessionExists): string[] {
  if (!sessionId) return [];
  if (exists(workDir, sessionId)) return ['--resume', sessionId];
  return ['--session-id', sessionId];
}

const tails = new Map<string, Promise<unknown>>();

export function withSessionLock<T>(sessionId: string | null, fn: () => Promise<T>): Promise<T> {
  if (!sessionId) return fn();
  const prev = tails.get(sessionId) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  tails.set(sessionId, next.catch(() => {}));
  return next;
}
