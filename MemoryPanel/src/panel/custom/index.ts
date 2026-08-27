import type { Hono } from 'hono';
import type { PanelDeps } from '../panel-deps.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerProxyConfigRoutes } from './routes/proxy-config.js';

/** 自定义面板功能的统一注册点。 */
export function registerCustomRoutes(api: Hono, deps: PanelDeps): void {
  registerChannelRoutes(api, deps);
  registerProxyConfigRoutes(api, deps);
}
