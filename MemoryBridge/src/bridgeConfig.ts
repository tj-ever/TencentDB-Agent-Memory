/**
 * Bridge 行为配置 —— 二开能力中心的桥接行为可配项持久层。
 *
 * 存 JSON（默认 data/bridge-config.json，BRIDGE_CONFIG_PATH 可覆盖）。字段见
 * BridgeConfig。缺省（无文件 / 未配置某字段）→ 该字段回退 runtime.ts 硬编码默认，
 * 行为与二开前逐字节一致。
 *
 * 写入路径：面板 PUT bridge /api/config → setBridgeConfig()（合并 + 原子落盘）。
 */

import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BridgeConfig {
  /** 会话重置指令词（正则 alternative），缺省用 runtime 默认 reset 正则。 */
  reset_commands?: string[];
  /** 重置成功回复。 */
  reset_reply_success?: string;
  /** 重置时当前无会话记录的回复。 */
  reset_reply_empty?: string;
  /** 帮助文案（HELP_TEXT，多行 markdown）。 */
  help_text?: string;
  /** 排队积压提示模板，`{n}` 占位排队条数。 */
  queue_notice_template?: string;
  /** 模型不支持识图时对图片消息的拒收回复。 */
  image_reject_reply?: string;
}

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bridge-config.json');

let _path = process.env.BRIDGE_CONFIG_PATH || DEFAULT_PATH;
let _config: BridgeConfig = {};

export function initBridgeConfig(path?: string): BridgeConfig {
  if (path) _path = path;
  if (!existsSync(_path)) {
    _config = {};
    return _config;
  }
  try {
    const parsed = JSON.parse(readFileSync(_path, 'utf8')) as BridgeConfig;
    _config = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`[bridge-config] load failed (${_path}):`, err instanceof Error ? err.message : String(err));
    _config = {};
  }
  return _config;
}

export function getBridgeConfig(): BridgeConfig {
  return _config;
}

const ALLOWED_KEYS: Array<keyof BridgeConfig> = [
  'reset_commands',
  'reset_reply_success',
  'reset_reply_empty',
  'help_text',
  'queue_notice_template',
  'image_reject_reply',
];

/**
 * 写入唯一入口（面板 PUT /api/config）。
 * - 值 string → 设置；reset_commands 接受 string[]（每个非空字符串）。
 * - 值 null/undefined（缺省 key）→ 删除该配置项 → runtime 回退代码默认。
 * - 其它类型 → 抛错（信任边界校验，fail fast）。
 * 合并而非替换（只改面板传的项），原子落盘后返回新配置。
 */
export function setBridgeConfig(input: Record<string, unknown>): BridgeConfig {
  const dst = _config as unknown as Record<string, unknown>;
  for (const k of ALLOWED_KEYS) {
    const v = input[k];
    // 显式 null = 删除该配置项（面板「恢复默认」）；缺省（undefined，未传的 key）= 保持不变。
    // 注意不能用 undefined 删除：面板单字段保存时只会带自己那个 key，其余字段须保留。
    if (v === null) {
      delete dst[k];
    } else if (v === undefined) {
      continue;
    } else if (k === 'reset_commands') {
      // reset_commands 只接受非空 string[]（字符串会导致 runtime 调 .some 崩掉）。
      if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim())) {
        dst[k] = v as string[];
      } else {
        throw new Error('invalid bridge config field: reset_commands (string[] expected)');
      }
    } else if (typeof v === 'string') {
      dst[k] = v;
    } else {
      throw new Error(`invalid bridge config field: ${k} (string expected)`);
    }
  }
  const target = _path;
  const temp = `${target}.${process.pid}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temp, JSON.stringify(_config, null, 2) + '\n');
  renameSync(temp, target);
  return { ..._config };
}

/** Tests only. */
export function __resetBridgeConfigForTests(): void {
  _config = {};
  _path = process.env.BRIDGE_CONFIG_PATH || DEFAULT_PATH;
}