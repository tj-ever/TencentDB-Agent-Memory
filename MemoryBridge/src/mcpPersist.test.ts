import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBotMcp } from './mcpPersist.js';

let home: string;
let prev: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mcpPersist-'));
  prev = process.env.CLAUDE_JSON_HOME;
  process.env.CLAUDE_JSON_HOME = home;
});

afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDE_JSON_HOME;
  else process.env.CLAUDE_JSON_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const env = {
  BRIDGE_MCP_WORKDIR: '/app/workspaces/yangguang',
  BRIDGE_MCP_HTTP_URL: 'http://192.168.0.103:3282/mcp',
  BRIDGE_MCP_HTTP_TOKEN: 'mcpr_test',
};

it('returns false when env not set', () => {
  expect(ensureBotMcp({})).toBe(false);
  expect(existsSync(join(home, '.claude.json'))).toBe(false);
});

it('writes mac-router into projects[cwd].mcpServers', () => {
  expect(ensureBotMcp(env)).toBe(true);
  const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  const proj = cfg.projects['/app/workspaces/yangguang'];
  expect(proj.mcpServers['mac-router'].url).toBe('http://192.168.0.103:3282/mcp');
  expect(proj.mcpServers['mac-router'].headers.Authorization).toBe('Bearer mcpr_test');
});

it('is idempotent — does not double write / duplicate', () => {
  ensureBotMcp(env);
  ensureBotMcp(env);
  const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  expect(Object.keys(cfg.projects['/app/workspaces/yangguang'].mcpServers)).toEqual(['mac-router']);
});

it('preserves existing projects and mac-router if already present', () => {
  const p = join(home, '.claude.json');
  writeFileSync(p, JSON.stringify({
    projects: {
      '/app/workspaces/yangguang': { mcpServers: { 'mac-router': { type: 'http', url: 'http://old/x' } } },
      '/app/workspaces/other': { mcpServers: {} },
    },
  }), 'utf8');
  ensureBotMcp(env);
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  // 已存在 mac-router → 不动原值；other 项目不受影响
  expect(cfg.projects['/app/workspaces/yangguang'].mcpServers['mac-router'].url).toBe('http://old/x');
  expect(cfg.projects['/app/workspaces/other']).toBeTruthy();
});
