import { it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, BotInput } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
process.env.BRIDGE_DATA_DIR = dir;
writeFileSync(join(dir, 'bots.json'), '{"bots":[]}');

let store: typeof import('./store.js');

beforeAll(async () => {
  // 动态导入：store 在模块加载时读取 BRIDGE_DATA_DIR
  store = await import('./store.js');
});

it('create masks secrets and update keeps them', () => {
  const bot = store.createBot({
    name: '卓驭',
    work_dir: dir,
    memory: { proxy_base_url: 'http://127.0.0.1:8096', space_id: 'default', user_key: 'sk-mem-abcdefghijklmnopqrstuvwxyz' },
    binding: { team_id: 'team-1', agent_id: 'agt-1', task_id: 'task-1' },
    feishu: { app_id: 'cli_x', app_secret: 'super-secret-value' },
    session_mode: 'user',
  } satisfies BotInput);
  expect(store.listBots().length).toBe(1);
  const pub = store.publicBot(bot);
  expect(pub.feishu.app_secret).toBe(store.SECRET_MASK);
  expect(pub.memory.user_key.endsWith('****')).toBe(true);
  expect(pub.session_mode).toBe('user');

  const updated = store.updateBot(bot.id, {
    ...bot,
    name: '卓驭2',
    memory: { ...bot.memory, user_key: store.SECRET_MASK },
    feishu: { ...bot.feishu, app_secret: store.SECRET_MASK },
  } satisfies BotInput);
  expect(updated?.name).toBe('卓驭2');
  expect(updated?.memory.user_key).toBe('sk-mem-abcdefghijklmnopqrstuvwxyz');
  expect(updated?.feishu.app_secret).toBe('super-secret-value');
  rmSync(dir, { recursive: true, force: true });
});

it('gits masks password, keeps on masked submit, resets when cleared', () => {
  const bot = store.createBot({
    name: '卓驭',
    work_dir: dir,
    memory: { proxy_base_url: 'http://127.0.0.1:8096', space_id: 'default', user_key: 'sk-u1' },
    binding: { team_id: 'team-1', agent_id: 'agt-1', task_id: 'task-1' },
    feishu: { app_id: 'cli_x', app_secret: 's' },
    session_mode: 'user',
    gits: [{ id: 'git-a', name: 'choerodon', host: 'code.choerodon.com.cn', username: 'lhq', password: 'tok-1234567890' }],
  } satisfies BotInput);
  const pub = store.publicBot(bot);
  expect(pub.gits[0]!.password).not.toContain('tok-1234567890');
  expect(pub.gits[0]!.password.endsWith('****')).toBe(true);

  // 掩码提交 → 保持原 token
  const kept = store.updateBot(bot.id, {
    ...bot,
    gits: [{ ...pub.gits[0]!, password: pub.gits[0]!.password }],
  } satisfies BotInput);
  expect(kept?.gits[0]!.password).toBe('tok-1234567890');

  // 整体清空 → 清空
  const cleared = store.updateBot(bot.id, { ...bot, gits: [] } satisfies BotInput);
  expect(cleared?.gits).toEqual([]);
});
