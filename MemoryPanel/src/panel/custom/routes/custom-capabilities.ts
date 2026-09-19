/**
 * /api/v1/custom-capabilities —— 二开能力中心
 *
 * Panel 只做鉴权 + 反代：
 *   - proxy 话术覆盖  → proxy /v3/config/custom-capabilities（写时清 hook cache）
 *   - bridge 行为覆盖 → bridge  /api/config
 * 程序说明（只读 doc）由前端 registry.ts 静态提供，不走后端。
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { respondControlError, respondEnvelope } from '../../http/envelope.js';
import { validatePanelMetaHeaders } from '../../http/middleware/validate-panel-headers.js';

function ok<T>(c: Parameters<typeof respondEnvelope>[0], data: T) {
  return respondEnvelope(c, { code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data });
}

/** 系统上游配置由内核确认的全局管理员管理（抄 proxy-config.ts）。 */
async function requireSystemAdmin(c: Context, deps: PanelDeps): Promise<Response | null> {
  const meta = c.get('panelMeta');
  if (!meta.userKey) return respondControlError(c, 401, 'INVALID_USER_KEY');
  const verified = await deps.metaKernel.invoke(
    'auth/verify',
    { user_key: meta.userKey },
    { ...meta, userKey: meta.userKey, reqId: c.get('reqId') },
  );
  const data = verified.data as { valid?: boolean; user?: { user_type?: string } } | null;
  if (verified.code !== 0 || !data?.valid) return respondControlError(c, 401, 'INVALID_USER_KEY');
  return data.user?.user_type === 'system_admin' ? null : respondControlError(c, 403, 'FORBIDDEN');
}

async function proxyFetch(c: Context, deps: PanelDeps, method: string, body?: unknown) {
  const meta = c.get('panelMeta');
  const res = await fetch(`${deps.config.proxy.baseUrl.replace(/\/$/, '')}/v3/config/custom-capabilities`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': meta.instanceId,
      'x-tdai-user-key': meta.userKey ?? '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* ignore */ }
  return { http: res.status, json, text };
}

async function bridgeFetch(deps: PanelDeps, method: string, body?: unknown) {
  const base = deps.config.bridge.baseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/api/config`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(deps.config.bridge.token ? { 'x-bridge-token': deps.config.bridge.token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: { code?: number; message?: string; data?: unknown } | null = null;
  try { json = JSON.parse(text) as { code?: number; message?: string; data?: unknown }; } catch { /* ignore */ }
  return { http: res.status, json, text };
}

export function registerCustomCapabilitiesRoutes(api: Hono, deps: PanelDeps): void {
  api.use('/custom-capabilities', validatePanelMetaHeaders(deps));

  const unavailable = (c: Parameters<typeof respondControlError>[0], where: string, err: unknown) => {
    deps.logger.warn(`${where} unavailable`, { err: err instanceof Error ? err.message : String(err) });
    return respondControlError(c, 503, where === 'proxy' ? 'PROXY_UNAVAILABLE' : 'BRIDGE_UNAVAILABLE');
  };

  api.get('/custom-capabilities', async (c) => {
    try {
      const denied = await requireSystemAdmin(c, deps);
      if (denied) return denied;

      const [proxy, bridge] = await Promise.all([
        proxyFetch(c, deps, 'GET').catch((err) => ({ http: 503, json: null as never, text: String(err) })),
        bridgeFetch(deps, 'GET').catch((err) => ({ http: 503, json: null as never, text: String(err) })),
      ]);
      if (!proxy.json) return respondControlError(c, 502, proxy.text.slice(0, 200));
      if (proxy.http !== 200) return respondControlError(c, proxy.http, String(proxy.json.error ?? 'proxy error'));

      // bridge 正常时返回其信封 data；异常（不部署 bridge）降级为空对象，不整页失败。
      const bridgeData = bridge.json?.code === 0 ? bridge.json.data : {};
      return ok(c, { proxy: proxy.json.capabilities ?? proxy.json, bridge: bridgeData });
    } catch (err) {
      return unavailable(c, 'panel', err);
    }
  });

  api.put('/custom-capabilities', async (c) => {
    try {
      const denied = await requireSystemAdmin(c, deps);
      if (denied) return denied;

      const body = (await c.req.json()) as {
        target?: string;
        payload?: Record<string, unknown>;
      };
      if (body.target !== 'proxy' && body.target !== 'bridge') {
        return respondControlError(c, 400, 'invalid target: proxy|bridge');
      }
      const payload = body.payload ?? {};

      if (body.target === 'proxy') {
        const out = await proxyFetch(c, deps, 'PUT', payload);
        if (!out.json) return respondControlError(c, 502, out.text.slice(0, 200));
        if (out.http !== 200) return respondControlError(c, out.http, String(out.json.error ?? 'proxy error'));
        return ok(c, out.json.capabilities ?? out.json);
      }

      const out = await bridgeFetch(deps, 'PUT', payload);
      if (!out.json) return respondControlError(c, 502, out.text.slice(0, 200));
      if (out.json.code !== 0) return respondControlError(c, out.json.code ?? 400, out.json.message || 'bridge error');
      return ok(c, out.json.data);
    } catch (err) {
      return unavailable(c, err instanceof Error && err.message.includes('bridge') ? 'bridge' : 'panel', err);
    }
  });
}