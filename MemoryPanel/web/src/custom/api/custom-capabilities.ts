import { customRequest } from './request';

/** Proxy 话术槽快照（对齐 MemoryProxy capability-defs.ts）。 */
export interface ProxyCapabilityItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** null = 未覆盖，注入器走代码内置默认。 */
  text: string | null;
}

/** Bridge 行为配置（对齐 MemoryBridge bridgeConfig.ts BridgeConfig）。 */
export interface BridgeConfigData {
  reset_commands?: string[];
  reset_reply_success?: string;
  reset_reply_empty?: string;
  help_text?: string;
  queue_notice_template?: string;
  image_reject_reply?: string;
}

export interface CapabilitiesState {
  proxy: ProxyCapabilityItem[];
  bridge: BridgeConfigData;
}

export type CapabilityTarget = 'proxy' | 'bridge';

export const customCapabilitiesApi = {
  get: () => customRequest<CapabilitiesState>('GET', '/api/v1/custom-capabilities'),
  update: (target: CapabilityTarget, payload: Record<string, unknown>) =>
    customRequest<Record<string, unknown>>('PUT', '/api/v1/custom-capabilities', { target, payload }),
};