import { createBridgeServer } from './http.js';
import { startEnabled } from './runtime.js';

const PORT = Number(process.env.BRIDGE_PORT || 8130);
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';

const server = createBridgeServer();
server.listen(PORT, HOST, async () => {
  console.log(`memory-bridge listening on http://${HOST}:${PORT}`);
  await startEnabled();
});
