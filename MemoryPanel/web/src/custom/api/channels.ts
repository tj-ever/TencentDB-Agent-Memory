import { customRequest } from './request';

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

const path = (id: string) => `/api/v1/channels/${encodeURIComponent(id)}`;

export const channelsApi = {
  list: (teamId?: string) => customRequest<ChannelBot[]>(
    'GET',
    `/api/v1/channels${teamId ? `?team_id=${encodeURIComponent(teamId)}` : ''}`,
  ),
  create: (body: ChannelDraft) => customRequest<ChannelBot>('POST', '/api/v1/channels', body),
  update: (id: string, body: ChannelDraft) => customRequest<ChannelBot>('PUT', path(id), body),
  remove: (id: string) => customRequest<{ ok: boolean }>('DELETE', path(id)),
  start: (id: string) => customRequest<ChannelBot>('POST', `${path(id)}/start`),
  stop: (id: string) => customRequest<ChannelBot>('POST', `${path(id)}/stop`),
};
