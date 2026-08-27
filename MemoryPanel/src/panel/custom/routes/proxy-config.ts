import type { Context, Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { respondControlError, respondEnvelope } from '../../http/envelope.js';
import { validatePanelMetaHeaders } from '../../http/middleware/validate-panel-headers.js';
import type { MetaCallContext } from '../../kernel/types.js';

function ok(c: Parameters<typeof respondEnvelope>[0], data: unknown) {
  return respondEnvelope(c, { code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data });
}

/** 从请求构造 MetaCallContext，用于调用内核元数据接口。 */
function metaCtx(c: Context): MetaCallContext {
  const meta = c.get('panelMeta');
  return {
    instanceId: meta.instanceId,
    gatewayEndpoint: meta.gatewayEndpoint,
    gatewayApiKey: meta.gatewayApiKey,
    userKey: meta.userKey ?? '',
    reqId: c.get('reqId'),
  };
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

/**
 * 为绑定 agent 自动开通记忆账号并注入其 memory 配置。
 *
 * 当一枚上游 agent 已绑定 team+agent 但尚未配置固定记忆账号（memory.key）时，
 * 本函数自动调用内核 user/create 为其炒一把 sk-mem key，并把 user_id 与当前
 * instance 空间写进该 agent 的 memory 配置。此后开发者只需自己的模型 Key + 路径，
 * 记忆身份完全由服务端的 agent 账号承担，无需手工维护记忆 Key。
 *
 * ponytail: 以「绑定即自动开通」的简化边界——命中即视为有权限使用该账号；
 * 如需更强访问控制，后续可在按 path 白名单上加限制（当前不做）。
 */
async function provisionAgentMemory(
  ctx: MetaCallContext,
  deps: PanelDeps,
  agentName: string,
  binding: { team_id: string; agent_id: string },
  spaceId: string,
): Promise<{ key: string; spaceId: string }> {
  const username = `agent-${agentName}-${binding.agent_id.slice(-6)}`;
  const envelope = await deps.metaKernel.invoke(
    'user/create',
    { username, auth_provider: 'api_key', external_id: username },
    ctx,
  );
  if (envelope.code !== 0) {
    throw new Error(`agent memory account create failed: ${envelope.message ?? envelope.code}`);
  }
  const data = envelope.data as { user_id?: string; default_user_key?: string } | null;
  const key = data?.default_user_key;
  if (!key) {
    throw new Error('agent memory account created but no key returned');
  }
  return { key, spaceId };
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
      const ctx = metaCtx(c);
      const spaceId = c.get('panelMeta').instanceId;
      const body = (await c.req.json()) as {
        agents?: Array<{
          name?: string;
          binding?: { team_id?: string; agent_id?: string; task_id?: string };
          memory?: { key?: string; spaceId?: string };
        }>;
      };
      // 自动开通：对「已绑定 team+agent 但尚未配记忆账号」的 agent 炒一把 sk-mem key，
      // 写进 memory 后交予 proxy 落盘；既有 memory 的跳过，保持幂等。
      if (Array.isArray(body.agents)) {
        const pinned = [];
        for (const a of body.agents) {
          const { team_id: teamId, agent_id: agentId } = a.binding ?? {};
          if (teamId && agentId && !a.memory?.key) {
            const p = await provisionAgentMemory(ctx, deps, a.name ?? '', { team_id: teamId, agent_id: agentId }, spaceId);
            pinned.push({ ...a, memory: { key: p.key, spaceId: p.spaceId } });
          } else {
            pinned.push(a);
          }
        }
        body.agents = pinned;
      }
      const out = await proxyFetch(c, deps, 'PUT', body);
      if (!out.data) return respondControlError(c, 502, out.text.slice(0, 200));
      if (out.status !== 200) return respondControlError(c, out.status, String(out.data.error ?? 'proxy error'));
      return ok(c, out.data);
    } catch (err) {
      return unavailable(c, err);
    }
  });
}
