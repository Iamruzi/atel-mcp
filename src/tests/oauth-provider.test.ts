import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformChallengeOAuthProvider } from '../oauth/provider.js';
import type { AtelScope } from '../contracts/scopes.js';

const baseConfig = {
  host: '127.0.0.1',
  port: 8787,
  trustProxy: 'loopback',
  publicBaseUrl: 'http://127.0.0.1:8787',
  oauthIssuerUrl: 'http://127.0.0.1:8787',
  routeBasePath: '',
  oauthResourceName: 'ATEL MCP',
  serviceDocumentationUrl: undefined,
  platformBaseUrl: 'https://api.atelai.xyz',
  registryBaseUrl: 'https://api.atelai.xyz',
  relayBaseUrl: 'https://api.atelai.xyz',
  environment: 'production' as const,
  defaultRemoteScopes: ['identity.read', 'messages.write'] as AtelScope[],
  allowCustomRemoteMcp: false,
  userEntryMode: 'mcp-primary' as const,
  runtimeRole: 'sdk-runtime' as const,
  runtimeBackends: ['platform-hosted', 'sdk-runtime'],
  supportedUserModes: ['mcp-only', 'runtime-only', 'mcp-plus-runtime'],
  runtimeLinksPath: '.runtime/runtime-links.json',
  runtimeLinksEnabled: true,
  auditPlatformIngestEnabled: false,
  auditPlatformReadEnabled: false,
  mcpInstance: 'test-instance',
};

test('PlatformChallengeOAuthProvider completes challenge-poll flow and exchanges auth code', async () => {
  const originalFetch = globalThis.fetch;
  let issuedCode = '';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);

    if (url.endsWith('/auth/v1/challenge')) {
      issuedCode = 'A1B2C3';
      return new Response(JSON.stringify({ code: issuedCode, expiresIn: 300 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith(`/auth/v1/poll/${issuedCode}`)) {
      return new Response(JSON.stringify({
        status: 'verified',
        token: 'atel-access-token',
        did: 'did:atel:ed25519:tester',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith('/auth/v1/session')) {
      return new Response(JSON.stringify({
        did: 'did:atel:ed25519:tester',
        environment: 'production',
        scopes: ['identity.read', 'messages.write'],
        sessionId: 'session:test',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        clientId: 'oauth-client',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const provider = new PlatformChallengeOAuthProvider(baseConfig, baseConfig.publicBaseUrl);
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'Test Client',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      logo_uri: undefined,
      tos_uri: undefined,
    });

    const redirects: string[] = [];
    await provider.authorize(client, {
      redirectUri: 'https://example.com/callback',
      state: 'state-1',
      scopes: ['identity.read'],
      codeChallenge: 'challenge-123',
    }, {
      redirect: (url: string) => {
        redirects.push(url);
      },
    } as never);

    assert.equal(redirects.length, 1);
    const interactive = new URL(redirects[0]!);
    const sessionId = interactive.searchParams.get('session');
    assert.ok(sessionId);

    const status = await provider.getLoginSessionStatus(sessionId!);
    assert.equal(status.status, 'verified');
    assert.ok(status.redirectTo);

    const callbackUrl = new URL(status.redirectTo);
    const authorizationCode = callbackUrl.searchParams.get('code');
    assert.ok(authorizationCode);
    assert.equal(callbackUrl.searchParams.get('state'), 'state-1');

    const tokens = await provider.exchangeAuthorizationCode(
      client,
      authorizationCode!,
      'verifier-123',
      'https://example.com/callback',
    );
    assert.equal(tokens.access_token, 'atel-access-token');
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.refresh_token);

    const authInfo = await provider.verifyAccessToken('atel-access-token');
    assert.equal(authInfo.clientId, 'oauth-client');
    assert.deepEqual(authInfo.scopes, ['identity.read', 'messages.write']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PlatformChallengeOAuthProvider preserves the public base path in authorize redirects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/challenge')) {
      return new Response(JSON.stringify({ code: 'PATH42', expiresIn: 300 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const provider = new PlatformChallengeOAuthProvider(
      {
        ...baseConfig,
        publicBaseUrl: 'http://43.160.230.129/atel-mcp',
        oauthIssuerUrl: 'http://43.160.230.129/atel-mcp',
        routeBasePath: '/atel-mcp',
      },
      'http://43.160.230.129/atel-mcp',
    );
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'Prefixed Client',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      logo_uri: undefined,
      tos_uri: undefined,
    });

    const redirects: string[] = [];
    await provider.authorize(client, {
      redirectUri: 'https://example.com/callback',
      codeChallenge: 'challenge-123',
    }, {
      redirect: (url: string) => {
        redirects.push(url);
      },
    } as never);

    assert.equal(redirects.length, 1);
    assert.match(redirects[0]!, /^http:\/\/43\.160\.230\.129\/atel-mcp\/oauth\/authorize\/interactive\?session=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// PKCE round-trip pin (T9.1).
//
// The PlatformChallengeOAuthProvider relies on the MCP SDK's express layer
// to validate PKCE (skipLocalPkceValidation = false). For that to work the
// provider MUST:
//   1. Accept params.codeChallenge in authorize()
//   2. Persist it into the session keyed by sessionId
//   3. Carry it through to the issued authorization-code record
//   4. Return EXACTLY the same value from challengeForAuthorizationCode(code)
//
// If any of those steps regresses, PKCE silently breaks: the SDK would
// either reject all valid verifiers (the challenge it gets back doesn't
// match the one the client sent) or — worse, if challengeForAuthorizationCode
// returns a placeholder — accept any verifier. This test pins the round-trip.
test('PKCE: codeChallenge persists across authorize → token-exchange round-trip', async () => {
  const originalFetch = globalThis.fetch;
  let issuedCode = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/challenge')) {
      issuedCode = 'PKCE42';
      return new Response(JSON.stringify({ code: issuedCode, expiresIn: 300 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith(`/auth/v1/poll/${issuedCode}`)) {
      return new Response(JSON.stringify({
        status: 'verified',
        token: 'tok-pkce',
        did: 'did:atel:ed25519:tester',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const provider = new PlatformChallengeOAuthProvider(baseConfig, baseConfig.publicBaseUrl);
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'PKCE Pin',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      logo_uri: undefined,
      tos_uri: undefined,
    });

    // Same shape a real RFC 7636 client would send: 43+ char base64url string.
    const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    const redirects: string[] = [];
    await provider.authorize(client, {
      redirectUri: 'https://example.com/callback',
      scopes: ['identity.read'],
      codeChallenge,
    }, {
      redirect: (url: string) => { redirects.push(url); },
    } as never);

    const interactive = new URL(redirects[0]!);
    const sessionId = interactive.searchParams.get('session')!;
    const status = await provider.getLoginSessionStatus(sessionId);
    if (status.status !== 'verified') {
      throw new Error(`expected verified, got ${status.status}`);
    }
    const callbackUrl = new URL(status.redirectTo);
    const authorizationCode = callbackUrl.searchParams.get('code')!;

    // The SDK's express layer calls this before exchangeAuthorizationCode
    // to verify the verifier locally. Our job is to return the SAME challenge
    // we accepted at authorize() time.
    const stored = await provider.challengeForAuthorizationCode(client, authorizationCode);
    assert.equal(stored, codeChallenge,
      'challengeForAuthorizationCode must return the EXACT codeChallenge from authorize() — otherwise SDK PKCE validation breaks silently');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PKCE: skipLocalPkceValidation must remain false (SDK enforces S256)', () => {
  // Pin the security property: provider hands PKCE validation to the SDK.
  // Flipping this flag without also implementing server-side S256 hashing
  // in exchangeAuthorizationCode would create a silent bypass.
  const provider = new PlatformChallengeOAuthProvider(baseConfig, baseConfig.publicBaseUrl);
  assert.equal(provider.skipLocalPkceValidation, false,
    'skipLocalPkceValidation must be false — flipping it disables PKCE without a server-side replacement');
});
