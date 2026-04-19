import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBearerToken, toAtelSession } from '../auth/session.js';
import { assertEnvironment, assertRemoteEnvironmentAllowed, assertScopes } from '../auth/guards.js';

test('parseBearerToken extracts bearer token', () => {
  assert.equal(parseBearerToken('Bearer abc123'), 'abc123');
});

test('toAtelSession maps claims to session', () => {
  const session = toAtelSession('token-1', {
    sub: 'did:atel:ed25519:test',
    did: 'did:atel:ed25519:test',
    env: 'production',
    scopes: ['identity.read', 'orders.read'],
    sessionId: 'session:1',
    issuedAt: 1,
    expiresAt: 2,
  });
  assert.equal(session.did, 'did:atel:ed25519:test');
  assert.equal(session.environment, 'production');
  assert.deepEqual(session.scopes, ['identity.read', 'orders.read']);
});

test('assertScopes accepts matching scopes', () => {
  assert.doesNotThrow(() => assertScopes({
    subject: 's', did: 'did:atel:ed25519:test', environment: 'production', scopes: ['orders.read'], bearerToken: 't', sessionId: '1', expiresAt: 1,
  }, { requireAll: ['orders.read'] }));
});

test('assertEnvironment rejects unexpected environment', () => {
  assert.throws(() => assertEnvironment({
    subject: 's', did: 'did:atel:ed25519:test', environment: 'custom', scopes: [], bearerToken: 't', sessionId: '1', expiresAt: 1,
  }, { allowed: ['production'] }));
});

test('assertRemoteEnvironmentAllowed rejects local-test', () => {
  assert.throws(() => assertRemoteEnvironmentAllowed({
    subject: 's', did: 'did:atel:ed25519:test', environment: 'local-test', scopes: [], bearerToken: 't', sessionId: '1', expiresAt: 1,
  }));
});
