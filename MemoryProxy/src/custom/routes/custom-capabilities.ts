import type { Context } from "hono";
import { isAuthEnabled, verifyUserKey } from "../../auth.js";
import { getCapabilityStore, setCapabilities, type CapabilityMap, type CapabilityOverride } from "../capability-store.js";
import { getCapabilityDefs } from "../capability-defs.js";
import type { ProxyConfig } from "../../types.js";
import { getHookCacheRepo } from "../../db/hookCacheRepo.js";

async function authorized(c: Context, config: ProxyConfig, requireAdmin: boolean): Promise<boolean> {
  const serviceId = c.req.header("x-tdai-service-id")?.trim();
  const userKey = c.req.header("x-tdai-user-key")?.trim();
  if (!serviceId || !userKey || config.tdai.serviceId && serviceId !== config.tdai.serviceId) return false;
  const verified = await verifyUserKey(userKey, config.tdai.serviceId || serviceId);
  return !verified.rejected && (!requireAdmin || isAuthEnabled() && verified.userType === "system_admin");
}

function snapshot() {
  const store = getCapabilityStore();
  return getCapabilityDefs().map((def) => {
    const o = store.getCapability(def.id);
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      enabled: o?.enabled ?? false,
      // null = 未覆盖，注入器走代码内置默认。
      text: o?.enabled && o.text ? o.text : null,
    };
  });
}

export function createCustomCapabilitiesHandlers(config: ProxyConfig) {
  return {
    get: async (c: Context): Promise<Response> => {
      // 覆盖文本本身是普通话术（非密钥），读放开给任一已认证用户；
      // 写仍限 admin。
      if (!(await authorized(c, config, false))) return c.json({ error: "unauthorized" }, 403);
      return c.json({ capabilities: snapshot() });
    },
    put: async (c: Context): Promise<Response> => {
      if (!(await authorized(c, config, true))) return c.json({ error: "admin required" }, 403);
      const body = await c.req.json<{
        capabilities?: Array<{ id?: unknown; enabled?: unknown; text?: unknown }>;
      }>().catch(() => null);
      if (!body || !Array.isArray(body.capabilities)) {
        return c.json({ error: "invalid body: capabilities[] required" }, 400);
      }

      const defs = getCapabilityDefs();
      const byId = new Set(defs.map((d) => d.id));
      const next: CapabilityMap = new Map();
      for (const item of body.capabilities) {
        const id = typeof item.id === "string" ? item.id.trim() : "";
        if (!id || !byId.has(id)) return c.json({ error: `unknown capability id: ${id}` }, 400);
        const enabled = item.enabled === true;
        const text = typeof item.text === "string" ? item.text : "";
        // enabled=false 或空文本 = 恢复代码内置默认（等价于未配置）。
        if (enabled && text.trim()) {
          next.set(id, { enabled: true, text } satisfies CapabilityOverride);
        } else {
          next.delete(id);
        }
      }

      setCapabilities(next); // 内存替换 + 原子落盘
      // 覆盖生效的关键：清除全部已缓存的注入块，下一条消息/新会话重新渲染。
      await getHookCacheRepo().clearAll();
      return c.json({ capabilities: snapshot() });
    },
  };
}
