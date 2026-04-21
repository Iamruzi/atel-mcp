import fs from 'node:fs';
import crypto from 'node:crypto';

function base64Url(buffer: Buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function makePkce() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function decodeSecretKey(raw: unknown) {
  if (typeof raw === 'string' && /^[0-9a-fA-F]+$/.test(raw)) return Buffer.from(raw, 'hex');
  if (typeof raw === 'string') return Buffer.from(raw, 'base64');
  throw new Error('Unsupported secretKey format');
}

async function readJson(response: Response) {
  return response.json().catch(async () => ({ raw: await response.text() }));
}

function requiredPath(pathValue: string, label: string) {
  if (!fs.existsSync(pathValue)) {
    throw new Error(`${label} not found: ${pathValue}`);
  }
  return pathValue;
}

async function main() {
  const serverBase =
    process.env.ATEL_MCP_REMOTE_BASE_URL ??
    process.env.ATEL_MCP_PUBLIC_BASE_URL ??
    'https://43-160-230-129.sslip.io';
  const platformBase = process.env.ATEL_PLATFORM_BASE_URL ?? 'https://api.atelai.org';
  const identityPath = requiredPath(
    process.env.ATEL_IDENTITY_PATH ?? '/root/.atel/identity.json',
    'ATEL identity',
  );
  const sdkDistPath = requiredPath(
    process.env.ATEL_SDK_DIST_PATH ?? '/root/.openclaw/workspace/atel-sdk/dist/index.js',
    'ATEL SDK dist',
  );
  const naclPath = requiredPath(
    process.env.ATEL_NACL_PATH ?? '/root/.openclaw/workspace/atel-sdk/node_modules/tweetnacl/nacl-fast.js',
    'tweetnacl',
  );

  const { serializePayload } = await import(sdkDistPath);
  const naclModule = await import(naclPath);
  const nacl = naclModule.default ?? naclModule;

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  const secretKey = decodeSecretKey(identity.secretKey);
  const { verifier, challenge } = makePkce();
  const redirectUri = 'https://example.com/callback';

  const registerResponse = await fetch(`${serverBase}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ATEL MCP Production Verify',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = await readJson(registerResponse);
  if (!registerResponse.ok) {
    throw new Error(`register failed: ${registerResponse.status} ${JSON.stringify(client)}`);
  }

  const authorizeUrl = new URL(`${serverBase}/authorize`);
  authorizeUrl.searchParams.set('client_id', String(client.client_id));
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', 'identity.read messages.read orders.read');
  authorizeUrl.searchParams.set('state', 'atel-mcp-production-verify');

  const authorizeResponse = await fetch(authorizeUrl, { method: 'GET', redirect: 'manual' });
  const interactiveLocation = authorizeResponse.headers.get('location');
  if (authorizeResponse.status !== 302 || !interactiveLocation) {
    throw new Error(`authorize failed: ${authorizeResponse.status} ${await authorizeResponse.text()}`);
  }

  const sessionId = new URL(interactiveLocation).searchParams.get('session');
  if (!sessionId) throw new Error('missing session id');

  const pendingResponse = await fetch(`${serverBase}/oauth/authorize/interactive/status/${encodeURIComponent(sessionId)}`);
  const pendingPayload = await readJson(pendingResponse);
  if (pendingPayload.status !== 'pending' || typeof pendingPayload.code !== 'string') {
    throw new Error(`unexpected pending payload: ${JSON.stringify(pendingPayload)}`);
  }

  const timestamp = new Date().toISOString();
  const payload = { code: pendingPayload.code, did: identity.did, timestamp };
  const signable = serializePayload({ payload, did: identity.did, timestamp });
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(signable), secretKey)).toString('base64');

  const verifyResponse = await fetch(`${platformBase}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: pendingPayload.code,
      did: identity.did,
      signature,
      timestamp,
    }),
  });
  const verifyPayload = await readJson(verifyResponse);
  if (!verifyResponse.ok) {
    throw new Error(`verify failed: ${verifyResponse.status} ${JSON.stringify(verifyPayload)}`);
  }

  let statusPayload: any = null;
  for (let i = 0; i < 15; i += 1) {
    const statusResponse = await fetch(`${serverBase}/oauth/authorize/interactive/status/${encodeURIComponent(sessionId)}`, {
      cache: 'no-store',
    });
    statusPayload = await readJson(statusResponse);
    if (statusPayload.status === 'verified' && statusPayload.redirectTo) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!statusPayload || statusPayload.status !== 'verified' || !statusPayload.redirectTo) {
    throw new Error(`authorization code not issued: ${JSON.stringify(statusPayload)}`);
  }

  const authorizationCode = new URL(statusPayload.redirectTo).searchParams.get('code');
  if (!authorizationCode) throw new Error('missing authorization code');

  const tokenResponse = await fetch(`${serverBase}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: String(client.client_id),
      code: authorizationCode,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  const tokenPayload = await readJson(tokenResponse);
  if (!tokenResponse.ok) {
    throw new Error(`token failed: ${tokenResponse.status} ${JSON.stringify(tokenPayload)}`);
  }

  const initializeResponse = await fetch(`${serverBase}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'oauth-init-production',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'atel-mcp-production-verify', version: '0.1.0' },
      },
    }),
  });
  const initializeText = await initializeResponse.text();
  if (!initializeResponse.ok) {
    throw new Error(`initialize failed: ${initializeResponse.status} ${initializeText}`);
  }

  const listToolsResponse = await fetch(`${serverBase}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'oauth-tools-list-production',
      method: 'tools/list',
      params: {},
    }),
  });
  const listToolsText = await listToolsResponse.text();
  if (!listToolsResponse.ok) {
    throw new Error(`tools/list failed: ${listToolsResponse.status} ${listToolsText}`);
  }

  const whoamiResponse = await fetch(`${serverBase}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'oauth-whoami-production',
      method: 'tools/call',
      params: {
        name: 'atel_whoami',
        arguments: {},
      },
    }),
  });
  const whoamiText = await whoamiResponse.text();
  if (!whoamiResponse.ok) {
    throw new Error(`whoami failed: ${whoamiResponse.status} ${whoamiText}`);
  }

  const toolMatches = [...listToolsText.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'production-oauth',
        serverBase,
        did: identity.did,
        clientId: client.client_id,
        initializeStatus: initializeResponse.status,
        toolCount: toolMatches.length,
        tools: toolMatches,
        whoamiPreview: whoamiText.slice(0, 300),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
