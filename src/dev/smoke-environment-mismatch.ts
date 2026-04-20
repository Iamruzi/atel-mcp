import { dispatchTool } from '../server/tool-dispatch.js';
import { loadConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';
import type { AuthIntrospectionClient } from '../auth/introspection.js';

const auth: AuthIntrospectionClient = {
  async introspectBearerToken() {
    return {
      sub: 'did:atel:ed25519:envtest',
      did: 'did:atel:ed25519:envtest',
      env: 'local-test',
      scopes: ['identity.read'],
      sessionId: 'session:envtest',
      issuedAt: 1,
      expiresAt: 9999999999,
      clientId: 'atel-mcp-env-smoke',
    };
  },
};

async function main() {
  try {
    await dispatchTool({
      toolName: 'atel_whoami',
      authorization: 'Bearer env-mismatch-token',
      config: loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org' } as never),
      auth,
    });
    throw new Error('Expected ENVIRONMENT_MISMATCH but tool invocation succeeded.');
  } catch (error) {
    if (!(error instanceof AtelMcpError)) throw error;
    if (error.code !== 'ENVIRONMENT_MISMATCH') throw error;
    console.log(JSON.stringify({
      ok: true,
      code: error.code,
      message: error.message,
      details: error.details,
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
