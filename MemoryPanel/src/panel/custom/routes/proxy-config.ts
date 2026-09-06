import type { Context, Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { respondControlError, respondEnvelope } from '../../http/envelope.js';
import { validatePanelMetaHeaders } from '../../http/middleware/validate-panel-headers.js';

function ok(c: Parameters<typeof respondEnvelope>[0], data: unknown) {
  return respondEnvelope(c, { code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data });
}

async function proxyFetch(c: Context, deps: PanelDeps, method: string, body?: unknown) {
  const meta = c.get('panelMeta');
  const res = await fetch(`${deps.config.proxy.baseUrl.replace(/\/$/, '')}/v3/config/upstream`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': meta.instanceId,
      'x-tdai-user-key': meta.userKey ?? '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) as Record<string, unknown>, text };
  } catch {
    return { status: res.status, data: null, text };
  }
}

/** 系统上游配置由内核确认的全局管理员管理。 */
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

export function registerProxyConfigRoutes(api: Hono, deps: PanelDeps): void {
  api.use('/proxy-config', validatePanelMetaHeaders(deps));

  const unavailable = (c: Parameters<typeof respondControlError>[0], err: unknown) => {
    deps.logger.warn('memory-proxy unavailable', { err: err instanceof Error ? err.message : String(err) });
    return respondControlError(c, 503, 'PROXY_UNAVAILABLE');
  };

  api.get('/proxy-config', async (c) => {
    try {
      const denied = await requireSystemAdmin(c, deps);
      if (denied) return denied;
      const out = await proxyFetch(c, deps, 'GET');
      if (!out.data) return respondControlError(c, 502, out.text.slice(0, 200));
      if (out.status !== 200) return respondControlError(c, out.status, String(out.data.error ?? 'proxy error'));
      return ok(c, { ...out.data, publicUrl: deps.config.proxy.publicUrl });
    } catch (err) {
      return unavailable(c, err);
    }
  });

  api.put('/proxy-config', async (c) => {
    try {
      const denied = await requireSystemAdmin(c, deps);
      if (denied) return denied;
      const body = await c.req.json();
      const out = await proxyFetch(c, deps, 'PUT', body);
      if (!out.data) return respondControlError(c, 502, out.text.slice(0, 200));
      if (out.status !== 200) return respondControlError(c, out.status, String(out.data.error ?? 'proxy error'));
      return ok(c, out.data);
    } catch (err) {
      return unavailable(c, err);
    }
  });
}
