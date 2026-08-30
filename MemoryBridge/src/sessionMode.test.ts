import { it, expect } from 'vitest';
import { parseSessionMode, projectSlug, resolveSessionId, sessionArgv, sessionUuid } from './sessionMode.js';

it('projectSlug 与 Claude Code 目录命名一致（非字母数字全替换）', () => {
  // 实测 ~/.claude/projects/：'.'、'/' 等均替换为 '-'（如 /Users/x/.claude/sites → -Users-x--claude-sites）
  expect(projectSlug('/app/workspaces/zhuoyu')).toBe('-app-workspaces-zhuoyu');
  expect(projectSlug('/home/node/.claude/x_y z')).toBe('-home-node--claude-x-y-z');
});

it('parseSessionMode aliases', () => {
  expect(parseSessionMode('2')).toBe('user');
  expect(parseSessionMode('per-chat')).toBe('chat');
  expect(parseSessionMode(undefined)).toBe('none');
  expect(() => parseSessionMode('nope')).toThrow();
});

it('resolveSessionId is stable per user', () => {
  const a = resolveSessionId({ mode: 'user', botName: '卓驭', userId: 'ou_1', chatId: 'oc_9' });
  const b = resolveSessionId({ mode: 'user', botName: '卓驭', userId: 'ou_1', chatId: 'oc_other' });
  const c = resolveSessionId({ mode: 'user', botName: '卓驭', userId: 'ou_2', chatId: 'oc_9' });
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(resolveSessionId({ mode: 'none', botName: 'x', userId: 'ou_1' })).toBeNull();
});

it('sessionArgv resume vs new', () => {
  const id = sessionUuid('seed');
  expect(sessionArgv('/tmp', id, () => true)).toEqual(['--resume', id]);
  expect(sessionArgv('/tmp', id, () => false)).toEqual(['--session-id', id]);
  expect(sessionArgv('/tmp', null)).toEqual([]);
});
