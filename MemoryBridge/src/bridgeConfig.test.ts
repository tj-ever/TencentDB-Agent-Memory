import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initBridgeConfig, getBridgeConfig, setBridgeConfig, __resetBridgeConfigForTests } from "./bridgeConfig.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
  __resetBridgeConfigForTests();
});

afterEach(() => {
  __resetBridgeConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("bridgeConfig", () => {
  it("无文件 → 空配置，getBridgeConfig 返回 {}（runtime 走代码默认）", () => {
    initBridgeConfig(join(dir, "missing.json"));
    expect(getBridgeConfig()).toEqual({});
  });

  it("加载既有 JSON", () => {
    const file = join(dir, "bridge-config.json");
    writeFileSync(file, JSON.stringify({ reset_commands: ["重置", "/clr"], help_text: "HELLO" }));
    initBridgeConfig(file);
    expect(getBridgeConfig()).toEqual({ reset_commands: ["重置", "/clr"], help_text: "HELLO" });
  });

  it("setBridgeConfig 合并而非替换：只改传入的字段,其余保留", () => {
    const file = join(dir, "bridge-config.json");
    initBridgeConfig(file);
    setBridgeConfig({ reset_reply_success: "已重置" });
    setBridgeConfig({ help_text: "多行\n文案" });
    const cfg = getBridgeConfig();
    expect(cfg.reset_reply_success).toBe("已重置");
    expect(cfg.help_text).toBe("多行\n文案");
  });

  it("值为 null → 删除配置项（回退代码默认）", () => {
    const file = join(dir, "bridge-config.json");
    initBridgeConfig(file);
    setBridgeConfig({ reset_reply_success: "x", help_text: "y" });
    setBridgeConfig({ reset_reply_success: null });
    expect(getBridgeConfig()).toEqual({ help_text: "y" });
  });

  it("非法字段类型 → 抛错 fail fast", () => {
    const file = join(dir, "bridge-config.json");
    initBridgeConfig(file);
    expect(() => setBridgeConfig({ reset_commands: "not-an-array" } as never)).toThrow();
    expect(() => setBridgeConfig({ help_text: 123 } as never)).toThrow();
  });

  it("reset_commands 接受非空 string[]，过滤语义由 runtime 负责", () => {
    const file = join(dir, "bridge-config.json");
    initBridgeConfig(file);
    setBridgeConfig({ reset_commands: ["重置", "/clr"] });
    expect(getBridgeConfig().reset_commands).toEqual(["重置", "/clr"]);
  });

  it("写盘原子：落盘文件为合法 JSON 且可被再次 init 读回", () => {
    const file = join(dir, "bridge-config.json");
    initBridgeConfig(file);
    setBridgeConfig({ reset_commands: ["重置"], image_reject_reply: "暂不支持图片" });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      reset_commands: ["重置"],
      image_reject_reply: "暂不支持图片",
    });

    __resetBridgeConfigForTests();
    initBridgeConfig(file);
    expect(getBridgeConfig()).toEqual({
      reset_commands: ["重置"],
      image_reject_reply: "暂不支持图片",
    });
  });
});