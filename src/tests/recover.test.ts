/**
 * Pin atel_recover behavior.
 *
 * Pre-auth lookup tool — submits recovery code, gets DID. Pairs with
 * atel_register_user (which returns the recovery code at registration).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool } from '../server/tool-dispatch.js';
import { loadConfig } from '../config.js';

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

const config = loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.xyz' } as never);

test('atel_recover: forwards recoveryCode to platform /auth/v1/recovery', async () => {
  const fake = withFakeFetch((req) => {
    if (req.url.endsWith('/auth/v1/recovery')) {
      return new Response(JSON.stringify({
        did: 'did:atel:ed25519:found',
        hint: 'DID recovered.',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  });
  try {
    const result = await dispatchTool({
      toolName: 'atel_recover',
      config,
      input: { recoveryCode: 'TESTRECOVERYCODE12345' },
    }) as { did: string };
    assert.equal(result.did, 'did:atel:ed25519:found');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://api.atelai.xyz/auth/v1/recovery');
    const sent = JSON.parse(String(fake.calls[0].init.body));
    assert.equal(sent.recoveryCode, 'TESTRECOVERYCODE12345');
  } finally {
    fake.restore();
  }
});

test('atel_recover: works without bearer (pre-auth path)', async () => {
  const fake = withFakeFetch(() =>
    new Response(JSON.stringify({ did: 'did:atel:ed25519:x' }), { status: 200 }),
  );
  try {
    // No authorization header.
    await dispatchTool({
      toolName: 'atel_recover',
      config,
      input: { recoveryCode: 'TESTRECOVERYCODE12345' },
    });
  } finally {
    fake.restore();
  }
});

test('atel_recover: schema rejects code shorter than 16 chars before platform call', async () => {
  const fake = withFakeFetch(() => new Response('{}', { status: 200 }));
  try {
    await assert.rejects(
      () => dispatchTool({
        toolName: 'atel_recover',
        config,
        input: { recoveryCode: 'short' },
      }),
      (err: unknown) => err instanceof Error,
    );
    // Critical: schema must reject before any network call.
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test('atel_recover: surfaces platform 404 (unknown code) as tool error', async () => {
  const fake = withFakeFetch(() =>
    new Response(JSON.stringify({ error: 'recovery code not found' }), { status: 404 }),
  );
  try {
    await assert.rejects(() => dispatchTool({
      toolName: 'atel_recover',
      config,
      input: { recoveryCode: 'WRONGCODEAAAAAAAAAA' },
    }));
  } finally {
    fake.restore();
  }
});
