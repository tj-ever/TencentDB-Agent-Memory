import { createBridgeServer } from './http.js';
import { startEnabled } from './runtime.js';
import { ensureBotMcp } from './mcpPersist.js';

const PORT = Number(process.env.BRIDGE_PORT || 8130);
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';

// 容器重建后 claude 首次启动会重置 ~/.claude.json（旧配置进 backups/），mac-router 会丢。
// 启动时幂等恢复指定 bot 工作目录的 mac-router（env BRIDGE_MCP_WORKDIR/URL/TOKEN 配置时生效）。
void ensureBotMcp();

// 用户撤回消息等飞书侧中断会在流式/重试路径抛未捕获 rejection，会把整个进程打崩再被 Docker 无限重启。
// 兜底：记日志并继续跑，而不是让一条外部消息击穿 bridge。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? `${reason.message} (${reason.stack?.split('\n')[1] ?? ''})` : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

const server = createBridgeServer();
server.listen(PORT, HOST, async () => {
  console.log(`memory-bridge listening on http://${HOST}:${PORT}`);
  await startEnabled();
});
