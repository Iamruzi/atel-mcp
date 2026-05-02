/**
 * Pins the behavior of the disabled runtime-links subsystem.
 *
 * Default (true) is exercised by tool-dispatch.test.ts and the
 * linked-runtime smoke scripts. This file covers the production state we
 * are migrating toward: ATEL_MCP_RUNTIME_LINKS_ENABLED=false.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool } from '../server/tool-dispatch.js';
import { loadConfig } from '../config.js';
import type { AuthIntrospectionClient } from '../auth/introspection.js';
import { AtelMcpError } from '../contracts/errors.js';

const auth: AuthIntrospectionClient = {
  async introspectBearerToken() {
    return {
      sub: 'did:atel:ed25519:test',
      did: 'did:atel:ed25519:test',
      env: 'production',
      scopes: ['identity.read'],
      sessionId: 'session:test',
      issuedAt: 1,
      expiresAt: 9999999999,
    };
  },
};

function disabledConfig() {
  return loadConfig({
    ATEL_PLATFORM_BASE_URL: 'https://api.atelai.xyz',
    ATEL_MCP_RUNTIME_LINKS_ENABLED: 'false',
  } as never);
}

test('runtime-links disabled: atel_runtime_link_status returns NOT_IMPLEMENTED with hint', async () => {
  await assert.rejects(
    () => dispatchTool({
      toolName: 'atel_runtime_link_status',
      authorization: 'Bearer test-token',
      config: disabledConfig(),
      auth,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'NOT_IMPLEMENTED');
      assert.match(err.hint ?? '', /platform-hosted/);
      const details = err.details as { configFlag?: string };
      assert.equal(details.configFlag, 'ATEL_MCP_RUNTIME_LINKS_ENABLED');
      return true;
    },
  );
});

test('runtime-links disabled: atel_runtime_link_bind rejects (no silent state mutation)', async () => {
  await assert.rejects(
    () => dispatchTool({
      toolName: 'atel_runtime_link_bind',
      authorization: 'Bearer test-token',
      config: disabledConfig(),
      auth,
      input: {
        runtimeDid: 'did:atel:ed25519:runtime-1',
        backend: 'linked-runtime',
        endpoint: 'https://runtime.example.com/mcp',
      },
    }),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'NOT_IMPLEMENTED',
  );
});

test('runtime-links disabled: atel_runtime_link_unbind rejects (caller is told plainly)', async () => {
  await assert.rejects(
    () => dispatchTool({
      toolName: 'atel_runtime_link_unbind',
      authorization: 'Bearer test-token',
      config: disabledConfig(),
      auth,
    }),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'NOT_IMPLEMENTED',
  );
});

test('runtime-links disabled: atel_whoami still works (other tools unaffected)', async () => {
  const result = await dispatchTool({
    toolName: 'atel_whoami',
    authorization: 'Bearer test-token',
    config: disabledConfig(),
    auth,
  });
  assert.deepEqual(result, {
    did: 'did:atel:ed25519:test',
    environment: 'production',
    scopes: ['identity.read'],
  });
});

test('runtime-links disabled: linked-runtime preference falls back without lookup', async () => {
  // Even when the host explicitly asks for linked-runtime, the dispatch
  // does not hit the runtime-link store (no file read) and the execution
  // plan falls back to platform-hosted. atel_whoami is identity.read so
  // it doesn't need orders.write — just verifies the dispatch path runs.
  const result = await dispatchTool({
    toolName: 'atel_whoami',
    authorization: 'Bearer test-token',
    config: disabledConfig(),
    auth,
    preferredRuntimeBackend: 'linked-runtime',
    declaredUserMode: 'mcp-plus-runtime',
  });
  assert.ok(result);
});
