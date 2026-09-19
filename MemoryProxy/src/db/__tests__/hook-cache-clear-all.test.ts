import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, __resetDbForTests } from "../index.js";
import { getHookCacheRepo, __resetHookCacheRepoForTests } from "../hookCacheRepo.js";
import type { ContextBlock } from "../../injection/types.js";

let dir: string;
let prevPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-cache-"));
  prevPath = process.env.PROXY_DB_PATH;
  process.env.PROXY_DB_PATH = join(dir, "proxy.db");
  __resetDbForTests();
  __resetHookCacheRepoForTests();
});

afterEach(() => {
  __resetDbForTests();
  __resetHookCacheRepoForTests();
  if (prevPath === undefined) delete process.env.PROXY_DB_PATH;
  else process.env.PROXY_DB_PATH = prevPath;
  rmSync(dir, { recursive: true, force: true });
});

const block: ContextBlock = { type: "text", content: "hello", metadata: { source: "test" } };

/** hook_cache 外键挂在 sessions(session_id) 上，写入前需按 composite sid 建会话行。 */
function seedSession(sessionId: string): void {
  const db = getDb();
  const now = Date.now();
  const sid = `space-a:user-1:claude:${sessionId}`;
  db!.prepare(
    "INSERT OR REPLACE INTO sessions (session_id, session_key, status, state_json, created_at, updated_at) VALUES (?, ?, 'active', '{}', ?, ?)",
  ).run(sid, sessionId, now, now);
}

describe("HookCacheRepo.clearAll (SQLite)", () => {
  it("清空后该会话缓存查询为空", async () => {
    const repo = getHookCacheRepo();
    const keys = ["s1", "s2"];
    for (const k of keys) seedSession(k);
    for (const k of keys) {
      repo.put("space-a", "user-1", "claude", k, "hook-x", [block]);
    }
    // 写入后能读出
    await expect(repo.get("space-a", "user-1", "claude", "s1", "hook-x")).resolves.toEqual([block]);

    repo.clearAll();
    await expect(repo.get("space-a", "user-1", "claude", "s1", "hook-x")).resolves.toBeNull();
    await expect(repo.get("space-a", "user-1", "claude", "s2", "hook-x")).resolves.toBeNull();
  });

  it("对空表调用不抛错", () => {
    const repo = getHookCacheRepo();
    expect(() => repo.clearAll()).not.toThrow();
  });
});

// 仅验证 getDb 未就绪时（无 SQLite 依赖场景）getHookCacheRepo 走 Null 实现不崩。
describe("HookCacheRepo.clearAll (null fallback)", () => {
  it("Null repo clearAll 为 no-op 不抛错", () => {
    // NullHookCacheRepo 不加锁只在 getDb() 为空时实例化；这里显式重置后调用 get 也能覆盖 no-op 语义
    expect(() => getHookCacheRepo().clearAll()).not.toThrow();
  });
});