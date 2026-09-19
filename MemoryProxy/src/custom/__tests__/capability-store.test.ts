import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initCapabilityStore,
  getCapabilityStore,
  setCapabilities,
  persistStore,
  __resetCapabilityStoreForTests,
} from "../capability-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cap-store-"));
  __resetCapabilityStoreForTests();
});

afterEach(() => {
  __resetCapabilityStoreForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("capability-store", () => {
  it("缺省：无文件 → 空 store，任何槽返回 undefined（走代码内置默认）", () => {
    const store = getCapabilityStore();
    expect(store.getCapability("skill-tools-injector:block")).toBeUndefined();
    expect(store.getCapability("nonexistent:block")).toBeUndefined();
  });

  it("initCapabilityStore 从磁盘加载覆盖表", () => {
    const file = join(dir, "caps.json");
    writeFileSync(file, JSON.stringify({
      "skill-injector:header": { enabled: true, text: "MY HEADER" },
      "skill-injector:footer": { enabled: false, text: "ignored" },
    }));
    initCapabilityStore(file);
    expect(getCapabilityStore().getCapability("skill-injector:header")).toEqual({ enabled: true, text: "MY HEADER" });
    // enabled=false 的项在 map 中仍存在（路由层负责语义），读取端需要自己判 enabled。
    expect(getCapabilityStore().getCapability("skill-injector:footer")).toEqual({ enabled: false, text: "ignored" });
  });

  it("损坏 JSON → 空 store（不抛错，降级走默认）", () => {
    const file = join(dir, "caps.json");
    writeFileSync(file, "{not-json");
    expect(() => initCapabilityStore(file)).not.toThrow();
    expect(getCapabilityStore().getCapability("skill-injector:header")).toBeUndefined();
  });

  it("setCapabilities 原子落盘：再 init 能读回同一份", () => {
    const file = join(dir, "caps.json");
    initCapabilityStore(file);
    setCapabilities(new Map([
      ["tdai-tools-injector:block", { enabled: true, text: "BLOCK OVERRIDE" }],
    ]));
    expect(readFileSync(file, "utf8")).toContain("BLOCK OVERRIDE");
    __resetCapabilityStoreForTests();
    initCapabilityStore(file);
    expect(getCapabilityStore().getCapability("tdai-tools-injector:block")).toEqual({
      enabled: true,
      text: "BLOCK OVERRIDE",
    });
  });

  it("persistStore 写入后文件存在且为合法 JSON（temp+rename 原子语义）", () => {
    const file = join(dir, "caps.json");
    initCapabilityStore(file);
    setCapabilities(new Map([
      ["knowledge-tools-injector:block", { enabled: true, text: "KNOWLEDGE" }],
    ]), /* persist */ false);
    persistStore();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      "knowledge-tools-injector:block": { enabled: true, text: "KNOWLEDGE" },
    });
  });
});