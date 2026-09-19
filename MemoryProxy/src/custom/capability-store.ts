/**
 * Custom capability override store — 二开能力中心的可配置话术持久层。
 *
 * 存「注入话术覆盖」：{ capabilityId: { enabled, text } }，key 见 capability-defs.ts。
 * 缺省（无 env / 文件不存在 / 未配置覆盖）→ 空 map，注入器全部走代码内置默认，
 * 行为与二开前逐字节一致。
 *
 * 写入路径唯一：面板 → proxy PUT /v3/config/custom-capabilities → setCapabilities +
 * persistStore。原子写（temp+rename）避免写一半崩溃留残文件。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface CapabilityOverride {
  enabled: boolean;
  /** 覆盖文本；未配置覆盖时该槽走代码内置默认。 */
  text?: string;
}

export type CapabilityMap = Map<string, CapabilityOverride>;

/** 注入器只依赖这个读接口，避免注入器与路由层耦合。 */
export interface CapabilityStore {
  getCapability(id: string): CapabilityOverride | undefined;
}

const DEFAULT_PATH = "data/custom-capabilities.json";

let _path = process.env.CUSTOM_CAPABILITIES_PATH || DEFAULT_PATH;
let _store: CapabilityMap = new Map();

function normalize(parsed: unknown): CapabilityMap {
  const map: CapabilityMap = new Map();
  if (!parsed || typeof parsed !== "object") return map;
  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const o = raw as Partial<CapabilityOverride> | null;
    if (!o || typeof o.enabled !== "boolean") continue;
    map.set(id, { enabled: o.enabled, text: typeof o.text === "string" ? o.text : undefined });
  }
  return map;
}

/** 启动时加载磁盘覆盖（无文件 → 空 map，不报错）。 */
export function initCapabilityStore(path?: string): CapabilityMap {
  if (path) _path = path;
  if (!existsSync(_path)) {
    _store = new Map();
    return _store;
  }
  try {
    _store = normalize(JSON.parse(readFileSync(_path, "utf8")));
  } catch (err) {
    console.warn(`[capability-store] load failed (${_path}):`, err instanceof Error ? err.message : String(err));
    _store = new Map();
  }
  return _store;
}

export function getCapabilityStore(): CapabilityStore {
  return { getCapability: (id) => _store.get(id) };
}

/** 面板 PUT 入口：整体替换覆盖表并原子落盘。返回替换后的 map 供快照。 */
export function setCapabilities(next: CapabilityMap, persist = true): CapabilityMap {
  _store = next;
  if (persist) persistStore();
  return _store;
}

export function persistStore(path?: string): void {
  const target = path || _path;
  const obj: Record<string, CapabilityOverride> = {};
  for (const [id, o] of _store) obj[id] = o;
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(temp, target);
}

/** Tests only. */
export function __resetCapabilityStoreForTests(): void {
  _store = new Map();
  _path = process.env.CUSTOM_CAPABILITIES_PATH || DEFAULT_PATH;
}
