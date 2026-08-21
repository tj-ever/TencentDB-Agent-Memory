/**
 * /api/v1/channels/* —— 飞书机器人渠道（custom: MemoryBridge）
 *
 * Panel 只做鉴权 + 反代，配置与长连接运行时在 MemoryBridge。
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';

function ok<T>(c: Parameters<typeof respondEnvelope>[0], data: T) {
  return respondEnvelope(c, { code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data });
}

async function bridge(deps: PanelDeps, method: string, path: string, body?: unknown) {
  const base = deps.config.bridge.baseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: { code?: number; message?: string; data?: unknown } | null = null;
  try { json = JSON.parse(text) as { code?: number; message?: string; data?: unknown }; } catch { /* ignore */ }
  return { http: res.status, json, text };
}

export function registerChannelRoutes(api: Hono, deps: PanelDeps): void {
  api.use('/channels/*', validatePanelMetaHeaders(deps));
  api.use('/channels', validatePanelMetaHeaders(deps));

  const unavailable = (c: Parameters<typeof respondControlError>[0], err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.warn('memory-bridge unavailable', { err: msg });
    return respondControlError(c, 503, 'BRIDGE_UNAVAILABLE');
  };

  api.get('/channels', async (c) => {
    try {
      const teamId = c.req.query('team_id') || '';
      const q = teamId ? `?team_id=${encodeURIComponent(teamId)}` : '';
      const out = await bridge(deps, 'GET', `/api/bots${q}`);
      if (!out.json) return respondControlError(c, 502, out.text.slice(0, 200));
      return ok(c, out.json.data ?? []);
    } catch (err) {
      return unavailable(c, err);
    }
  });

  api.post('/channels', async (c) => {
    try {
      const out = await bridge(deps, 'POST', '/api/bots', await c.req.json());
      if (!out.json) return respondControlError(c, 502, out.text.slice(0, 200));
      if (out.json.code !== 0) return respondControlError(c, out.json.code ?? 400, out.json.message || 'error');
      return ok(c, out.json.data);
    } catch (err) {
      return unavailable(c, err);
    }
  });

  api.put('/channels/:id', async (c) => {
    try {
      const out = await bridge(deps, 'PUT', `/api/bots/${encodeURIComponent(c.req.param('id'))}`, await c.req.json());
      if (!out.json) return respondControlError(c, 502, out.text.slice(0, 200));
      if (out.json.code !== 0) return respondControlError(c, out.json.code ?? 400, out.json.message || 'error');
      return ok(c, out.json.data);
    } catch (err) {
      return unavailable(c, err);
    }
  });

  api.delete('/channels/:id', async (c) => {
    try {
      const out = await bridge(deps, 'DELETE', `/api/bots/${encodeURIComponent(c.req.param('id'))}`);
      if (!out.json) return respondControlError(c, 502, out.text.slice(0, 200));
      if (out.json.code !== 0) return respondControlError(c, out.json.code ?? 400, out.json.message || 'error');
      return ok(c, out.json.data);
    } catch (err) {
      return unavailable(c, err);
    }
  });

  api.post('/channels/:id/:action', async (c) => {
    const action = c.req.param('action');
    if (action !== 'start' && action !== 'stop') return respondControlError(c, 404, 'NOT_FOUND');
    try {
      const out = await bridge(deps, 'POST', `/api/bots/${encodeURIComponent(c.req.param('id'))}/${action}`);
      if (!out.json) return respondControlError(c, 502, out.text.slice(0, 200));
      if (out.json.code !== 0) return respondControlError(c, out.json.code ?? 400, out.json.message || 'error');
      return ok(c, out.json.data);
    } catch (err) {
      return unavailable(c, err);
    }
  });
}
