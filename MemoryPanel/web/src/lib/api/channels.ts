/**
 * api/channels.ts — 飞书机器人渠道（custom: 反代 MemoryBridge）
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

export interface ChannelBot {
  id: string;
  name: string;
  work_dir: string;
  enabled: boolean;
  memory: { proxy_base_url: string; space_id: string; user_key: string };
  binding: { team_id: string; agent_id: string; task_id: string };
  feishu: {
    app_id: string;
    app_secret: string;
    stream_initial_text: string;
    policy: { requireMention: boolean; dmMode: string; dmAllowlist?: string[] };
  };
  llm: { model: string };
  session_mode: 'none' | 'user' | 'chat';
  system_prompt: string;
  created_at: string;
  updated_at: string;
  status: 'running' | 'stopped' | 'error';
  error: string | null;
}

export type ChannelDraft = Omit<ChannelBot, 'id' | 'created_at' | 'updated_at' | 'status' | 'error' | 'enabled'> & {
  enabled?: boolean;
};

function headers() {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  return {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  };
}

async function unwrap<T>(method: string, path: string, body?: unknown): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>(method, path, body, headers());
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const channelsApi = {
  list: (teamId?: string) =>
    unwrap<ChannelBot[]>('GET', `/api/v1/channels${teamId ? `?team_id=${encodeURIComponent(teamId)}` : ''}`),
  create: (body: ChannelDraft) => unwrap<ChannelBot>('POST', '/api/v1/channels', body),
  update: (id: string, body: ChannelDraft) => unwrap<ChannelBot>('PUT', `/api/v1/channels/${encodeURIComponent(id)}`, body),
  remove: (id: string) => unwrap<{ ok: boolean }>('DELETE', `/api/v1/channels/${encodeURIComponent(id)}`),
  start: (id: string) => unwrap<ChannelBot>('POST', `/api/v1/channels/${encodeURIComponent(id)}/start`),
  stop: (id: string) => unwrap<ChannelBot>('POST', `/api/v1/channels/${encodeURIComponent(id)}/stop`),
};
