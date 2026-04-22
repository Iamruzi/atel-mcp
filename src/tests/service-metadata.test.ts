import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { buildServiceMetadata } from '../server/http-transport.js';

test('buildServiceMetadata exposes MCP-primary and runtime compatibility framing', () => {
  const config = loadConfig({
    ATEL_PLATFORM_BASE_URL: 'http://127.0.0.1:18204',
    ATEL_MCP_PUBLIC_BASE_URL: 'https://mcp.atel.test',
    ATEL_MCP_OAUTH_ISSUER_URL: 'https://mcp.atel.test',
    ATEL_MCP_RUNTIME_BACKENDS: 'platform-hosted,sdk-runtime',
    ATEL_MCP_SUPPORTED_USER_MODES: 'mcp-only,runtime-only,mcp-plus-runtime',
  } as never);
  const metadata = buildServiceMetadata(config);
  assert.equal(metadata.architecture.userEntryMode, 'mcp-primary');
  assert.equal(metadata.architecture.runtimeRole, 'sdk-runtime');
  assert.deepEqual(metadata.architecture.runtimeBackends, ['platform-hosted', 'sdk-runtime']);
  assert.deepEqual(metadata.architecture.supportedUserModes, ['mcp-only', 'runtime-only', 'mcp-plus-runtime']);
  assert.equal(metadata.architecture.sourceOfTruth, 'platform');
});
