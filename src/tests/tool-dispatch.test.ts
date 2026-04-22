import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchTool } from '../server/tool-dispatch.js';
import type { AuthIntrospectionClient } from '../auth/introspection.js';
import { loadConfig } from '../config.js';

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

test('dispatchTool runs atel_whoami with injected auth', async () => {
  const result = await dispatchTool({
    toolName: 'atel_whoami',
    authorization: 'Bearer test-token',
    config: loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org' } as never),
    auth,
  });
  assert.deepEqual(result, {
    did: 'did:atel:ed25519:test',
    environment: 'production',
    scopes: ['identity.read'],
  });
});

test('dispatchTool accepts staged runtime routing hints without changing execution backend yet', async () => {
  const result = await dispatchTool({
    toolName: 'atel_whoami',
    authorization: 'Bearer test-token',
    config: loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org' } as never),
    auth,
    preferredRuntimeBackend: 'sdk-runtime',
    declaredUserMode: 'mcp-plus-runtime',
  });
  assert.deepEqual(result, {
    did: 'did:atel:ed25519:test',
    environment: 'production',
    scopes: ['identity.read'],
  });
});

test('dispatchTool exposes runtime-link status for the current identity', async () => {
  const result = await dispatchTool({
    toolName: 'atel_runtime_link_status',
    authorization: 'Bearer test-token',
    config: loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org' } as never),
    auth,
  }) as {
    did: string;
    linked: boolean;
    runtimeLink: unknown;
    executionPlan: Record<string, unknown>;
    architecture: Record<string, unknown>;
  };

  assert.equal(result.did, 'did:atel:ed25519:test');
  assert.equal(result.linked, false);
  assert.equal(result.runtimeLink, null);
  assert.equal(result.executionPlan.selectedBackend, 'platform-hosted');
  assert.equal(result.executionPlan.executionClass, 'platform-truth-read');
  assert.equal(result.executionPlan.runtimeEligible, false);
  assert.deepEqual(result.executionPlan.futureBackends, []);
  assert.equal(result.executionPlan.runtimeLinkStatus, 'none');
  assert.equal(result.executionPlan.reason, 'platform is the source of truth for this tool class');
  assert.deepEqual(result.architecture, {
    userEntryMode: 'mcp-primary',
    runtimeRole: 'sdk-runtime',
    runtimeBackends: ['platform-hosted', 'sdk-runtime', 'linked-runtime'],
    supportedUserModes: ['mcp-only', 'runtime-only', 'mcp-plus-runtime'],
    sourceOfTruth: 'platform',
  });
});

test('dispatchTool binds and unbinds runtime-link for the current identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-runtime-link-dispatch-'));
  const config = loadConfig({
    ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org',
    ATEL_MCP_RUNTIME_LINKS_PATH: join(dir, 'runtime-links.json'),
  } as never);

  try {
    const bindResult = await dispatchTool({
      toolName: 'atel_runtime_link_bind',
      authorization: 'Bearer test-token',
      config,
      auth,
      input: {
        runtimeDid: 'did:atel:ed25519:runtime-1',
        backend: 'linked-runtime',
        endpoint: 'https://runtime.example.com/mcp',
      },
    }) as {
      did: string;
      action: string;
      changed: boolean;
      linked: boolean;
      runtimeLink: Record<string, unknown>;
    };

    assert.equal(bindResult.did, 'did:atel:ed25519:test');
    assert.equal(bindResult.action, 'bind');
    assert.equal(bindResult.changed, true);
    assert.equal(bindResult.linked, true);
    assert.equal(bindResult.runtimeLink.hostedDid, 'did:atel:ed25519:test');
    assert.equal(bindResult.runtimeLink.runtimeDid, 'did:atel:ed25519:runtime-1');
    assert.equal(bindResult.runtimeLink.backend, 'linked-runtime');

    const statusResult = await dispatchTool({
      toolName: 'atel_runtime_link_status',
      authorization: 'Bearer test-token',
      config,
      auth,
    }) as { linked: boolean; runtimeLink: Record<string, unknown> };

    assert.equal(statusResult.linked, true);
    assert.equal(statusResult.runtimeLink.runtimeDid, 'did:atel:ed25519:runtime-1');

    const unbindResult = await dispatchTool({
      toolName: 'atel_runtime_link_unbind',
      authorization: 'Bearer test-token',
      config,
      auth,
    }) as { action: string; changed: boolean; linked: boolean; runtimeLink: unknown };

    assert.equal(unbindResult.action, 'unbind');
    assert.equal(unbindResult.changed, true);
    assert.equal(unbindResult.linked, false);
    assert.equal(unbindResult.runtimeLink, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
