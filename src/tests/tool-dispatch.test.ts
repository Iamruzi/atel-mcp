import test from 'node:test';
import assert from 'node:assert/strict';
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
