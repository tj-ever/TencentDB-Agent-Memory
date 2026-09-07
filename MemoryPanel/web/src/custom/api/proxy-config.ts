import { customRequest } from './request';

export interface ProxyAgentConfig {
  name: string;
  originalName?: string;
  url: string;
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

export interface ProxyUserUpstream {
  /** 内核 auth/verify 返回的 user_id（如 usr-xxxxxxxx）。 */
  userId: string;
  /** 该用户的模型上游 base URL；模型 Key 始终客户端自带透传。 */
  url: string;
}

export interface ProxyAgentUpstream {
  /** 内核 agent_id（如 agt-xxxxxxxx）。 */
  agentId: string;
  /** 该 agent 的模型上游 base URL；模型 Key 始终客户端自带透传。 */
  url: string;
  /** agent 所在租户实例（service id），默认 default，单租户可留空。 */
  spaceId?: string;
}

export interface ProxyConfigState {
  url: string;
  apiKey: string;
  userAgent: string;
  model: string;
  supportsImages: boolean;
  profiles: ProxyProfile[];
  agents: ProxyAgentConfig[];
  userUpstreams?: ProxyUserUpstream[];
  agentUpstreams?: ProxyAgentUpstream[];
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
  }>;
  /** 按用户 BYOK 绑定，全量替换（不传 = 不动）。 */
  userUpstreams?: ProxyUserUpstream[];
  /** 按 agent 绑定，全量替换（不传 = 不动）。 */
  agentUpstreams?: ProxyAgentUpstream[];
}

export const proxyConfigApi = {
  get: () => customRequest<ProxyConfigState>('GET', '/api/v1/proxy-config'),
  update: (body: ProxyConfigInput) => customRequest<ProxyConfigState>('PUT', '/api/v1/proxy-config', body),
};
