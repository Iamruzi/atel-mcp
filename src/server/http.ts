import { loadConfig } from '../config.js';
import { createHttpTransportApp } from './http-transport.js';

const config = loadConfig();
const app = createHttpTransportApp();

app.listen(config.port, config.host, () => {
  const listenPath = config.routeBasePath ? `${config.routeBasePath}/mcp` : '/mcp';
  console.log(`[atel-mcp] listening on http://${config.host}:${config.port}${listenPath}`);
});
