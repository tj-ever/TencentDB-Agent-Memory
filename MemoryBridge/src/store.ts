import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseSessionMode, type SessionMode } from './sessionMode.js';

const DATA_DIR = process.env.BRIDGE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'bots.json');
const SECRET_MASK = '********';
// 容器部署指向同网络 proxy（BRIDGE_PROXY_DEFAULT 注入），本机跑默认 127.0.0.1
const DEFAULT_PROXY_URL = process.env.BRIDGE_PROXY_DEFAULT || 'http://127.0.0.1:8096';

export type BotStatus = 'stopped' | 'running' | 'error';

export interface BotPolicy {
  requireMention: boolean;
  dmMode: 'open' | 'allowlist' | 'pair' | 'disabled';
  dmAllowlist?: string[];
}

export interface Bot {
  id: string;
  name: string;
  work_dir: string;
  enabled: boolean;
  memory: { proxy_base_url: string; space_id: string; user_key: string };
  binding: { team_id: string; agent_id: string; task_id: string };
  feishu: { app_id: string; app_secret: string; stream_initial_text: string; policy: BotPolicy };
  llm: { model: string };
  session_mode: SessionMode;
  system_prompt: string;
  created_at: string;
  updated_at: string;
}

/** 面板/HTTP 提交的机器人配置：全部字段可缺省，密钥传掩码表示「保持原值」。 */
export type BotInput = { [K in keyof Bot]?: Bot[K] extends object ? Partial<Bot[K]> : Bot[K] };

interface RawStore { bots: Bot[]; }

function now(): string {
  return new Date().toISOString();
}

function loadRaw(): RawStore {
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8')) as RawStore;
  } catch {
    return { bots: [] };
  }
}

function saveRaw(data: RawStore) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function required(bot: Bot) {
  const keys = [
    'name', 'work_dir',
    'memory.proxy_base_url', 'memory.space_id', 'memory.user_key',
    'binding.team_id', 'binding.agent_id', 'binding.task_id',
    'feishu.app_id', 'feishu.app_secret',
  ];
  for (const key of keys) {
    const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], bot);
    if (!v || String(v).startsWith('<') || v === SECRET_MASK) {
      throw new Error(`缺少必填项: ${key}`);
    }
  }
}

export function maskSecret(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return SECRET_MASK;
  return `${v.slice(0, 8)}****`;
}

export function publicBot(bot: Bot, status: BotStatus = 'stopped', error: string | null = null) {
  return {
    id: bot.id,
    name: bot.name,
    work_dir: bot.work_dir,
    enabled: !!bot.enabled,
    memory: {
      proxy_base_url: bot.memory.proxy_base_url,
      space_id: bot.memory.space_id,
      user_key: maskSecret(bot.memory.user_key),
    },
    binding: { ...bot.binding },
    feishu: {
      app_id: bot.feishu.app_id,
      app_secret: SECRET_MASK,
      stream_initial_text: bot.feishu.stream_initial_text || '思考中…',
      policy: bot.feishu.policy || { requireMention: true, dmMode: 'open' },
    },
    llm: { model: bot.llm.model || 'grok-4.6' },
    session_mode: bot.session_mode,
    system_prompt: bot.system_prompt || '',
    created_at: bot.created_at,
    updated_at: bot.updated_at,
    status,
    error,
  };
}

function normalize(input: BotInput, prev: Bot | null): Bot {
  const policy: BotPolicy = {
    requireMention: true,
    dmMode: 'open',
    ...(prev?.feishu.policy || {}),
    ...(input.feishu?.policy || {}),
  };
  const userKey = input.memory?.user_key;
  const appSecret = input.feishu?.app_secret;
  return {
    id: prev?.id || `bot-${randomBytes(4).toString('hex')}`,
    name: String(input.name || prev?.name || '').trim(),
    work_dir: String(input.work_dir || prev?.work_dir || '').trim(),
    enabled: input.enabled ?? prev?.enabled ?? false,
    memory: {
      proxy_base_url: input.memory?.proxy_base_url || prev?.memory.proxy_base_url || DEFAULT_PROXY_URL,
      space_id: input.memory?.space_id || prev?.memory.space_id || 'default',
      user_key: (!userKey || userKey === SECRET_MASK || userKey.endsWith('****'))
        ? prev?.memory.user_key ?? ''
        : userKey,
    },
    binding: {
      team_id: input.binding?.team_id || prev?.binding.team_id || '',
      agent_id: input.binding?.agent_id || prev?.binding.agent_id || '',
      task_id: input.binding?.task_id || prev?.binding.task_id || '',
    },
    feishu: {
      app_id: input.feishu?.app_id || prev?.feishu.app_id || '',
      app_secret: (!appSecret || appSecret === SECRET_MASK)
        ? prev?.feishu.app_secret ?? ''
        : appSecret,
      stream_initial_text: input.feishu?.stream_initial_text || prev?.feishu.stream_initial_text || '思考中…',
      policy,
    },
    llm: { model: input.llm?.model || prev?.llm.model || 'grok-4.6' },
    session_mode: parseSessionMode(input.session_mode ?? prev?.session_mode ?? 'none'),
    system_prompt: input.system_prompt ?? prev?.system_prompt ?? '',
    created_at: prev?.created_at || now(),
    updated_at: now(),
  };
}

export function listBots(): Bot[] {
  return loadRaw().bots;
}

export function getBot(id: string): Bot | null {
  return loadRaw().bots.find((b) => b.id === id) || null;
}

export function createBot(input: BotInput): Bot {
  const bot = normalize(input, null);
  required(bot);
  const data = loadRaw();
  data.bots.push(bot);
  saveRaw(data);
  return bot;
}

export function updateBot(id: string, input: BotInput): Bot | null {
  const data = loadRaw();
  const idx = data.bots.findIndex((b) => b.id === id);
  if (idx < 0) return null;
  const bot = normalize(input, data.bots[idx]!);
  required(bot);
  data.bots[idx] = bot;
  saveRaw(data);
  return bot;
}

export function deleteBot(id: string): boolean {
  const data = loadRaw();
  const next = data.bots.filter((b) => b.id !== id);
  if (next.length === data.bots.length) return false;
  data.bots = next;
  saveRaw(data);
  return true;
}

export { FILE as BOTS_FILE, SECRET_MASK };
