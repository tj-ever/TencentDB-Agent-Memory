import { it, expect } from 'vitest';
import { mkdtempSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeAskpassScript } from './gitCreds.js';

const dir = mkdtempSync(join(tmpdir(), 'gitcreds-'));
const bot = { id: 'bot-abc', gits: [] };

function scriptForHosts(creds: Array<{ host: string; username: string; password: string }>) {
  return writeAskpassScript(
    { id: 'bot-abc', gits: creds.map((c, i) => ({ id: `git-${i}`, name: 'x', ...c })) },
    dir,
  )!;
}

it('writes 0700 executable script only when creds present', () => {
  expect(writeAskpassScript(bot, dir)).toBeNull();
  const p = scriptForHosts([{ host: 'code.choerodon.com.cn', username: 'lhq', password: 'tok-123' }]);
  expect(p).toBeTruthy();
  // 0700：属主可执行（git 直接 exec askpass）+ 仅属主可读（token 不外泄）
  expect(statSync(p).mode & 0o777).toBe(0o700);
});

it('answers username and password for matching host', () => {
  const p = scriptForHosts([{ host: 'code.choerodon.com.cn', username: 'lhq', password: 'tok-123' }]);
  // git 直接 exec askpass 脚本（argv0=脚本，prompt=$1），这里同样直接 exec
  expect(String(execFileSync(p, ["Username for 'https://code.choerodon.com.cn':"], { encoding: 'utf8' })).trim()).toBe('lhq');
  expect(String(execFileSync(p, ["Password for 'https://lhq@code.choerodon.com.cn':"], { encoding: 'utf8' })).trim()).toBe('tok-123');
  unlinkSync(p);
});

it('fails fast (exit 1) when host not matched', () => {
  const p = scriptForHosts([{ host: 'code.choerodon.com.cn', username: 'lhq', password: 'tok-123' }]);
  expect(() => execFileSync(p, ["Username for 'https://github.com':"], { encoding: 'utf8' })).toThrow();
});