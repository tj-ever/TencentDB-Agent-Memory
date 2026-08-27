import { customRequest } from './request';

export interface PendingMessage {
  id: string;
  senderId: string;
  senderName?: string;
  content: string;
  ts: number;
  image?: boolean;
}

export interface BotSessionState {
  status: 'running' | 'stopped' | 'error';
  queue: PendingMessage[];
  sessions: Array<{
    sessionId: string;
    userName?: string;
    bytes: number;
    lines: number;
    imageBlocks: number;
    mtime: string;
  }>;
}

const path = (botId: string) => `/api/v1/channels/${encodeURIComponent(botId)}`;

export const sessionMgmtApi = {
  list: (botId: string) => customRequest<BotSessionState>('GET', `${path(botId)}/sessions`),
  abort: (botId: string) => customRequest<{ ok: boolean }>('POST', `${path(botId)}/abort`),
  clear: (botId: string, sessionId: string) =>
    customRequest<{ ok: boolean }>('POST', `${path(botId)}/sessions/${encodeURIComponent(sessionId)}/clear`),
};
