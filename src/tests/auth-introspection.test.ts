import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformAuthIntrospectionClient } from '../auth/introspection.js';
import type { AtelScope } from '../contracts/scopes.js';

const baseConfig = {
  host: '127.0.0.1',
  port: 8787,
  platformBaseUrl: 'https://api.atelai.org',
  registryBaseUrl: 'https://api.atelai.org',
  relayBaseUrl: 'https://api.atelai.org',
  environment: 'production' as const,
  defaultRemoteScopes: ['identity.read', 'orders.read'] as AtelScope[],
  allowCustomRemoteMcp: false,
};

test('PlatformAuthIntrospectionClient prefers /auth/v1/session when available', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify({
      did: 'did:atel:ed25519:session',
      environment: 'production',
      scopes: ['identity.read', 'messages.write'],
      sessionId: 'session:abc',
      issuedAt: 10,
      expiresAt: 20,
      clientId: 'atel-mcp-remote',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const client = new PlatformAuthIntrospectionClient(baseConfig);
    const claims = await client.introspectBearerToken('token-1');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /\/auth\/v1\/session$/);
    assert.equal(claims.did, 'did:atel:ed25519:session');
    assert.deepEqual(claims.scopes, ['identity.read', 'messages.write']);
    assert.equal(claims.sessionId, 'session:abc');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PlatformAuthIntrospectionClient falls back to /auth/v1/me when session endpoint is unavailable', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/auth/v1/session')) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      did: 'did:atel:ed25519:me',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const client = new PlatformAuthIntrospectionClient(baseConfig);
    const claims = await client.introspectBearerToken('token-2');
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, /\/auth\/v1\/session$/);
    assert.match(calls[1]!, /\/auth\/v1\/me$/);
    assert.equal(claims.did, 'did:atel:ed25519:me');
    assert.deepEqual(claims.scopes, ['identity.read', 'orders.read']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
