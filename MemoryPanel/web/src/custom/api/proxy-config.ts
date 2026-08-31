import { customRequest } from './request';

export interface ProxyAgentConfig {
  name: string;
  originalName?: string;
  url: string;
  model: string;
  binding?: { team_id: string; agent_id: string; task_id?: string };
  memory?: { key?: string; spaceId?: string };
}

export interface ProxyProfile {
  id: string;
  name: string;
  url: string;
  /** 回显为掩码（前 6 位 + …）；提交时含 … 视为未修改，服务端保留明文。 */
  apiKey: string;
  userAgent: string;
  model: string;
  supportsImages: boolean;
  enabled: boolean;
}

export interface ProxyConfigState {
  url: string;
  apiKey: string;
  userAgent: string;
  model: string;
  supportsImages: boolean;
  profiles: ProxyProfile[];
  agents: ProxyAgentConfig[];
  publicUrl?: string;
}

export interface ProxyConfigInput {
  url: string;
  apiKey?: string;
  model?: string;
  supportsImages?: boolean;
  /** 表格全量提交；enabled 那条派生为生效 upstream。 */
  profiles?: Array<Pick<ProxyProfile, 'id' | 'name' | 'url' | 'apiKey' | 'userAgent' | 'model' | 'supportsImages' | 'enabled'>>;
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
