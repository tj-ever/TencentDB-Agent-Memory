import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectSlug, sessionFilePath } from './sessionMode.js';
import type { Bot } from './store.js';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERS_FILE = join(process.env.BRIDGE_DATA_DIR || join(homedir(), '.claude'), 'sessionUsers.json');
const users = new Map<string, { id: string; name: string }>();

try {
  const saved = JSON.parse(readFileSync(USERS_FILE, 'utf8')) as Record<string, { id: string; name: string }>;
  for (const [sessionId, user] of Object.entries(saved)) users.set(sessionId, user);
} catch { /* 首次启动无映射文件 */ }

export interface SessionMeta {
  sessionId: string;
  userName?: string;
  bytes: number;
  lines: number;
  imageBlocks: number;
  mtime: string;
}

export function rememberSessionUser(sessionId: string, id: string, name: string): void {
  const previous = users.get(sessionId);
  if (previous?.name && previous.name.length >= name.length) return;
  users.set(sessionId, { id, name: name || id });
  try {
    mkdirSync(dirname(USERS_FILE), { recursive: true });
    writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users), null, 2));
  } catch { /* 展示信息不阻断消息 */ }
}

export function listBotSessions(bot: Bot): SessionMeta[] {
  const dir = join(homedir(), '.claude', 'projects', projectSlug(bot.work_dir));
  if (!existsSync(dir)) return [];
  const sessions: SessionMeta[] = [];
  for (const fileName of readdirSync(dir)) {
    const sessionId = fileName.replace(/\.jsonl$/, '');
    if (!fileName.endsWith('.jsonl') || !SESSION_ID_RE.test(sessionId)) continue;
    const file = join(dir, fileName);
    const stat = statSync(file);
    const contents = readFileSync(file, 'utf8');
    sessions.push({
      sessionId,
      userName: users.get(sessionId)?.name,
      bytes: stat.size,
      lines: contents.split('\n').filter(Boolean).length,
      imageBlocks: contents.split('"type":"image"').length - 1,
      mtime: new Date(stat.mtimeMs).toISOString(),
    });
  }
  return sessions.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function clearBotSession(bot: Bot, sessionId: string): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  const file = sessionFilePath(bot.work_dir, sessionId);
  try {
    if (existsSync(file)) {
      unlinkSync(file);
      return true;
    }
  } catch { /* 删除失败由 false 明确返回 */ }
  return false;
}
