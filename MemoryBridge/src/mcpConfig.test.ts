import { it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMcpJson, resolveMcpServer } from './mcpConfig.js';

const dir = mkdtempSync(join(tmpdir(), 'mcpcfg-'));
const env = {
  BRIDGE_MCP_HTTP_URL: 'http://192.168.0.103:3282/mcp',
  BRIDGE_MCP_HTTP_TOKEN: 'mcpr_test',
};

it('resolveMcpServer returns null when url unset', () => {
  expect(resolveMcpServer({})).toBeNull();
});

it('resolveMcpServer builds http server with bearer header', () => {
  expect(resolveMcpServer(env)).toEqual({
    type: 'http',
    url: 'http://192.168.0.103:3282/mcp',
    headers: { Authorization: 'Bearer mcpr_test' },
  });
});

it('ensureMcpJson writes .mcp.json with mac-router into workDir', () => {
  const wd = join(dir, 'w1');
  expect(ensureMcpJson(wd, env)).toBe(true);
  expect(existsSync(join(wd, '.mcp.json'))).toBe(true);
  const cfg = JSON.parse(readFileSync(join(wd, '.mcp.json'), 'utf8'));
  expect(cfg.mcpServers['mac-router'].url).toBe('http://192.168.0.103:3282/mcp');
  expect(cfg.mcpServers['mac-router'].headers.Authorization).toBe('Bearer mcpr_test');
});

it('no-ops (returns false, writes nothing) when env unset', () => {
  const wd = join(dir, 'w2');
  expect(ensureMcpJson(wd, {})).toBe(false);
  expect(existsSync(join(wd, '.mcp.json'))).toBe(false);
});

it('is idempotent (does not rewrite identical file)', () => {
  const wd = join(dir, 'w3');
  ensureMcpJson(wd, env);
  const p = join(wd, '.mcp.json');
  const before = readFileSync(p, 'utf8');
  ensureMcpJson(wd, env);
  expect(readFileSync(p, 'utf8')).toBe(before);
});

it('overwrites stale file content', () => {
  const wd = join(dir, 'w4');
  const p = join(wd, '.mcp.json');
  mkdirSync(wd, { recursive: true });
  writeFileSync(p, '{old:true}', 'utf8');
  ensureMcpJson(wd, env);
  expect(JSON.parse(readFileSync(p, 'utf8')).mcpServers['mac-router']).toBeTruthy();
  rmSync(wd, { recursive: true, force: true });
});