import { loadConfig } from './config.js';
import { listPlannedTools } from './tools/index.js';
import { MVP_MANIFEST } from './server/manifest.js';
import { listRegisteredTools } from './server/tool-registry.js';

const config = loadConfig();

console.log(JSON.stringify({
  name: 'atel-mcp',
  version: '0.1.0',
  environment: config.environment,
  platformBaseUrl: config.platformBaseUrl,
  plannedTools: listPlannedTools(),
  registeredTools: listRegisteredTools(),
  manifestGroups: Object.keys(MVP_MANIFEST)
}, null, 2));
