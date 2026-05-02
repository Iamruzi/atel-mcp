/**
 * Pin behavior of atel_register_user end-to-end through dispatch.
 *
 * This is the FIRST pre-auth tool — verifies dispatch correctly routes
 * around session resolution / scope check, calls platform's register
 * endpoint, and returns the bundle. Regression here means new users
 * can't onboard via Claude Desktop / Cursor / etc.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool } from '../server/tool-dispatch.js';
import { isPreAuthTool, PRE_AUTH_TOOLS } from '../server/pre-auth.js';
import { loadConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';
import type { AuditEvent } from '../contracts/audit.js';
import type { AuditSink } from '../server/context.js';

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

function withFakeFetch(handler: (req: CapturedFetch) => Response | Promise<Response>) {
  const calls: CapturedFetch[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured: CapturedFetch = { url: String(input), init: init ?? {} };
    calls.push(captured);
    return handler(captured);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

class CapturingAuditSink implements AuditSink {
  public events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const config = loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.xyz' } as never);

test('pre-auth registry: atel_register_user is registered as pre-auth', () => {
  assert.equal(isPreAuthTool('atel_register_user'), true);
  assert.equal(isPreAuthTool('atel_whoami'), false);
  assert.equal(PRE_AUTH_TOOLS.size, 1, 'pre-auth set should stay small; new entries need security review');
});

test('atel_register_user: forwards input to platform /auth/v1/register and returns bundle', async () => {
  const fake = withFakeFetch((req) => {
    if (req.url.endsWith('/auth/v1/register')) {
      const body = JSON.parse(String(req.init.body));
      return new Response(JSON.stringify({
        did: 'did:atel:ed25519:abc123',
        secretKey: 'base64-secret-key',
        publicKey: 'abc123',
        token: 'jwt-token-xyz',
        expiresAt: 9999999999,
        sessionId: 'register:did:atel:ed25519:abc123',
        walletStatus: 'pending',
        sourceLabel: body.sourceLabel,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  });

  try {
    // No authorization header — pre-auth path.
    const result = await dispatchTool({
      toolName: 'atel_register_user',
      config,
      input: { sourceLabel: 'claude-desktop-test' },
    }) as Record<string, unknown>;

    assert.equal(result.did, 'did:atel:ed25519:abc123');
    assert.equal(result.token, 'jwt-token-xyz');
    assert.equal(result.walletStatus, 'pending');

    // Verify the right endpoint was hit.
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://api.atelai.xyz/auth/v1/register');
    assert.equal(fake.calls[0].init.method, 'POST');

    // Verify sourceLabel propagated.
    const sentBody = JSON.parse(String(fake.calls[0].init.body));
    assert.equal(sentBody.sourceLabel, 'claude-desktop-test');
  } finally {
    fake.restore();
  }
});

test('atel_register_user: works WITHOUT bearer token (proves session bypass)', async () => {
  const fake = withFakeFetch(() =>
    new Response(JSON.stringify({
      did: 'did:atel:ed25519:fresh',
      secretKey: 'sk',
      publicKey: 'fresh',
      token: 't',
      expiresAt: 1,
      sessionId: 's',
      walletStatus: 'pending',
    }), { status: 200 }),
  );
  try {
    // No `authorization` field — would fail on every other tool.
    await dispatchTool({
      toolName: 'atel_register_user',
      config,
      input: {},
    });
    // If we got here, the bypass works.
  } finally {
    fake.restore();
  }
});

test('atel_register_user: emits tool.invoked + tool.succeeded with preAuth=true marker', async () => {
  const audit = new CapturingAuditSink();
  const fake = withFakeFetch(() =>
    new Response(JSON.stringify({
      did: 'did:atel:ed25519:audit',
      secretKey: 'sk',
      publicKey: 'audit',
      token: 't',
      expiresAt: 1,
      sessionId: 's',
      walletStatus: 'pending',
    }), { status: 200 }),
  );
  try {
    await dispatchTool({
      toolName: 'atel_register_user',
      config,
      audit,
      input: {},
    });
    const types = audit.events.map((e) => e.type);
    assert.ok(types.includes('tool.invoked'), `missing tool.invoked, got: ${types.join(',')}`);
    assert.ok(types.includes('tool.succeeded'), `missing tool.succeeded, got: ${types.join(',')}`);
    // Audit metadata flagged as pre-auth so operators can filter.
    const invoked = audit.events.find((e) => e.type === 'tool.invoked');
    assert.equal(invoked?.metadata?.preAuth, true);
  } finally {
    fake.restore();
  }
});

test('atel_register_user: surfaces platform 5xx as a tool error, captured in audit', async () => {
  const audit = new CapturingAuditSink();
  const fake = withFakeFetch(() =>
    new Response(JSON.stringify({ error: 'database unavailable' }), { status: 500 }),
  );
  try {
    await assert.rejects(() => dispatchTool({
      toolName: 'atel_register_user',
      config,
      audit,
      input: {},
    }));
    const failed = audit.events.find((e) => e.type === 'tool.failed');
    assert.ok(failed, 'expected tool.failed audit event');
    assert.equal(failed?.metadata?.preAuth, true);
  } finally {
    fake.restore();
  }
});

test('atel_register_user: rejects sourceLabel longer than schema max', async () => {
  const fake = withFakeFetch(() => new Response('{}', { status: 200 }));
  try {
    await assert.rejects(
      () => dispatchTool({
        toolName: 'atel_register_user',
        config,
        input: { sourceLabel: 'x'.repeat(100) }, // > 64 char limit
      }),
      (err: unknown) => err instanceof Error,
    );
    // Critically: should NOT have hit platform if schema rejected.
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});
