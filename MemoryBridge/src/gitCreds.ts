/**
 * gitCreds —— 机器人 git 凭证（HTTPS+token）运行时落盘 + git 认证注入。
 *
 * 机制：git 对 https 仓库认证失败时，若设了 `GIT_ASKPASS`（或 core.askPass），
 * 会调用该可执行文件，并把 prompt（形如 `Username for 'https://code.choerodon.com.cn':`）
 * 作为唯一参数交给它；脚本 stdout 输出回答。我们为每个机器人生成一个 0600 的
 * askpass 脚本（含 token 明文，只落持久卷 /app/data，绝不进 claude 子进程 env），
 * 按 prompt 中的 host 匹配该机器人的 `gits[]`，命中返回 user/token，未命中退出 1
 * 让 git 快速失败（配合 `GIT_TERMINAL_PROMPT=0`，绝不交互挂起机器人）。
 */

import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitCredential } from './store.js';

/** 把一条 git 凭证转成 askpass 脚本里的一个分支（shell 引号安全）。 */
function branch(cred: GitCredential): string {
  // git 的 askpass prompt 只含裸 host（`Username for 'https://host':`），从不带仓库路径；
  // 归一化配置值（剥掉 scheme/user@/路径）再匹配，兼容「填完整仓库 URL」的配置。
  const host = coreHost(cred.host.trim());
  const user = cred.username.replace(/'/g, "'\\''");
  const pass = cred.password.replace(/'/g, "'\\''");
  return [
    `if printf '%s' "$1" | grep -Fqi "${host}"; then`,
    `  if printf '%s' "$1" | grep -qi "username"; then`,
    `    echo '${user}'`,
    `  elif printf '%s' "$1" | grep -qi "password"; then`,
    `    echo '${pass}'`,
    `  else`,
    `    return 1`,
    `  fi`,
    `  exit 0`,
    `fi`,
  ].join('\n');
}

/** 从配置 host 里剥出裸 host：去掉 scheme、user@、路径/查询。 */
function coreHost(h: string): string {
  return h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/[/?#].*$/, '');
}

/**
 * 为机器人生成（或覆盖）其 GIT_ASKPASS 脚本，返回脚本路径。
 * gits 为空时返回 null（不注入 askpass，保持机器人原 git 行为）。
 * 脚本 0700（git 会直接 exec 它，必须有执行位；仅属主可读写），含 token 明文——
 * 只写在 dataDir（持久卷），不进任何 env。
 */
export function writeAskpassScript(bot: { id: string; gits: GitCredential[] }, dataDir: string): string | null {
  const gits = (bot.gits || []).filter((g) => g.host.trim() && g.username.trim() && g.password);
  if (!gits.length) return null;
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, `git-askpass-${bot.id}.sh`);
  const body = [
    '#!/bin/sh',
    ...gits.flatMap((g) => branch(g).split('\n').map((l) => `  ${l}`)),
    '# 未命中任何凭证 → 快速失败（配合 GIT_TERMINAL_PROMPT=0，绝不交互挂起）',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o700);
  return path;
}

/** 停止/删除机器人时清理 askpass 脚本（文件不存在则吞错）。 */
export function removeAskpassScript(botId: string, dataDir: string): void {
  try {
    unlinkSync(join(dataDir, `git-askpass-${botId}.sh`));
  } catch {
    /* 不存在即忽略 */
  }
}