import { customRequest } from './request';

export interface ProxyAgentConfig {
  name: string;
  originalName?: string;
  url: string;
  model: string;
  binding?: { team_id: string; agent_id: string; task_id?: string };
  memory?: { key?: string; spaceId?: string };
}

export interface ProxyConfigState {
  url: string;
  apiKey: string;
  model: string;
  supportsImages: boolean;
  agents: ProxyAgentConfig[];
  publicUrl?: string;
}

export interface ProxyConfigInput {
  url: string;
  apiKey?: string;
  model?: string;
  supportsImages?: boolean;
  agents?: Array<Pick<ProxyAgentConfig, 'name' | 'url'> & {
    originalName?: string;
    model?: string;
    binding?: ProxyAgentConfig['binding'];
    memory?: ProxyAgentConfig['memory'];
  }>;
}

export const proxyConfigApi = {
  get: () => customRequest<ProxyConfigState>('GET', '/api/v1/proxy-config'),
  update: (body: ProxyConfigInput) => customRequest<ProxyConfigState>('PUT', '/api/v1/proxy-config', body),
};
