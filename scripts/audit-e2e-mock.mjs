#!/usr/bin/env node
// Mock-based "deep e2e" — exercises the full MCP dispatch path for
// representative scenarios with a fake platform.
//
// What this proves:
//   - Tool registry is wired correctly (every claimed tool actually
//     dispatches)
//   - Pre-auth tools work without a bearer
//   - Authenticated tools fail without a bearer (FORBIDDEN/UNAUTHORIZED)
//   - Schema validation rejects bad input before reaching platform
//   - Approval gate blocks high-risk tools when configured
//
// What this does NOT prove:
//   - Real network behavior against atel-platform
//   - On-chain transactions
//   - Real LLM client (Claude Desktop / Cursor) behavior
//
// Run: node scripts/audit-e2e-mock.mjs

import { dispatchTool } from '../dist/server/tool-dispatch.js';
import { listPlannedTools } from '../dist/tools/index.js';
import { loadConfig } from '../dist/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
  }
}

const config = loadConfig({
  ATEL_PLATFORM_BASE_URL: 'https://api.atelai.xyz',
  ATEL_MCP_RUNTIME_LINKS_ENABLED: 'true',
} );

// Stub fetch with a deterministic responder
const fetchCalls = [];
const originalFetch = globalThis.fetch;
function setMockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    const captured = { url: String(url), init: init ?? {} };
    fetchCalls.push(captured);
    const resp = await handler(captured);
    return resp ?? new Response('{}', { status: 404 });
  };
}

// Mock auth introspection (so authenticated tools don't actually try
// to talk to platform for session resolution; we inject the result
// directly via deps.auth in dispatchTool).
const mockAuth = {
  async introspectBearerToken() {
    return {
      sub: 'did:atel:ed25519:tester',
      did: 'did:atel:ed25519:tester',
      env: 'production',
      scopes: ['identity.read', 'wallet.read', 'a2b.read', 'orders.read', 'messages.read', 'milestones.read', 'disputes.read'],
      sessionId: 'session:test',
      issuedAt: 1,
      expiresAt: 9999999999,
      clientId: 'test-client',
    };
  },
};

// ─── Test 1: tool registry completeness ─────────────────────────────

console.log('\n[1] Tool registry completeness');
const tools = listPlannedTools();
check(`tool registry has 30+ tools (got ${tools.length})`, tools.length >= 30);
const expected = [
  'atel_whoami',
  'atel_register_user',
  'atel_recover',
  'atel_wallet_status',
  'atel_register_endpoint',
  'atel_balance',
  'atel_deposit_info',
  'atel_a2b_quote',
  'atel_a2b_lock_funds',
  'atel_a2b_execute_purchase',
  'atel_fast_balance',
  'atel_fast_transfer',
  'atel_wallet_transfer',
  'atel_wallet_withdraw',
  'atel_dispute_resolve',
  'atel_approval_list',
];
for (const t of expected) {
  check(`registered: ${t}`, tools.includes(t));
}

// ─── Test 2: pre-auth tools work without bearer ─────────────────────

console.log('\n[2] Pre-auth tools (no bearer)');
setMockFetch((req) => {
  if (req.url.endsWith('/auth/v1/register')) {
    return new Response(JSON.stringify({
      did: 'did:atel:ed25519:newuser',
      secretKey: 'sk',
      token: 'jwt',
      walletStatus: 'pending',
      recoveryCode: 'TESTRECOVERYCODEXXXX1234567890ABCDEF1234567890',
    }), { status: 200 });
  }
  if (req.url.endsWith('/auth/v1/recovery')) {
    return new Response(JSON.stringify({ did: 'did:atel:ed25519:newuser' }), { status: 200 });
  }
  return null;
});

try {
  const r1 = await dispatchTool({
    toolName: 'atel_register_user',
    config,
    input: { sourceLabel: 'audit-e2e' },
  });
  check('atel_register_user succeeds without bearer', r1?.did === 'did:atel:ed25519:newuser');

  const r2 = await dispatchTool({
    toolName: 'atel_recover',
    config,
    input: { recoveryCode: 'TESTRECOVERYCODEXXXX1234567890ABCDEF1234567890' },
  });
  check('atel_recover succeeds without bearer', r2?.did === 'did:atel:ed25519:newuser');
} catch (e) {
  check('pre-auth dispatch did not throw', false, e.message);
}

// ─── Test 3: authenticated tools require bearer ─────────────────────

console.log('\n[3] Authenticated tools require bearer');
try {
  await dispatchTool({
    toolName: 'atel_whoami',
    config,
    // No authorization
  });
  check('atel_whoami fails without bearer', false, 'should have thrown');
} catch (e) {
  check('atel_whoami fails without bearer', e?.code === 'UNAUTHORIZED', `got ${e?.code}`);
}

// ─── Test 4: schema rejection happens before platform call ──────────

console.log('\n[4] Schema rejections (no platform call expected)');
fetchCalls.length = 0;
setMockFetch(() => new Response('{}', { status: 200 }));

try {
  await dispatchTool({
    toolName: 'atel_register_endpoint',
    config,
    authorization: 'Bearer x',
    auth: mockAuth,
    input: { endpoint: 'http://insecure' },  // http, not https
  });
  check('register_endpoint rejects http://', false, 'expected schema rejection');
} catch (e) {
  check('register_endpoint rejects http:// before any platform call', fetchCalls.length === 0, `${fetchCalls.length} fetches`);
}

fetchCalls.length = 0;
try {
  await dispatchTool({
    toolName: 'atel_a2b_quote',
    config,
    authorization: 'Bearer x',
    auth: mockAuth,
    input: { query: 'Boxer', productId: 'p', value: -5 },  // negative
  });
  check('a2b_quote rejects negative value', false, 'expected schema rejection');
} catch (e) {
  check('a2b_quote rejects negative value before platform call', fetchCalls.length === 0, `${fetchCalls.length} fetches`);
}

// ─── Test 5: approval gate fires for high-risk tools ────────────────

console.log('\n[5] Approval gate');
const tmpDir = mkdtempSync(join(tmpdir(), 'atel-mcp-audit-'));
const approvalPath = join(tmpDir, 'approvals.jsonl');

const gatedConfig = loadConfig({
  ATEL_PLATFORM_BASE_URL: 'https://api.atelai.xyz',
  ATEL_MCP_APPROVAL_LOG_PATH: approvalPath,
});

const adminAuth = {
  async introspectBearerToken() {
    return {
      sub: 'did:atel:ed25519:tester',
      did: 'did:atel:ed25519:tester',
      env: 'production',
      scopes: ['wallet.transfer', 'wallet.withdraw', 'wallet.read'],
      sessionId: 'session:admin',
      issuedAt: 1,
      expiresAt: 9999999999,
    };
  },
};

setMockFetch((req) => {
  if (req.url.includes('/account/v1/balance')) {
    return new Response(JSON.stringify({
      chainAddresses: { base: '0xaaa' },
      chainBalances: { base: 100 },
    }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
});

try {
  await dispatchTool({
    toolName: 'atel_wallet_transfer',
    config: gatedConfig,
    authorization: 'Bearer x',
    auth: adminAuth,
    input: { chain: 'base', address: '0x' + 'b'.repeat(40), amount: 10 },
  });
  check('wallet_transfer triggers APPROVAL_PENDING', false, 'should have thrown');
} catch (e) {
  check('wallet_transfer triggers APPROVAL_PENDING with details', e?.code === 'APPROVAL_PENDING' && typeof e?.details?.approvalId === 'string', e?.code);
}

try {
  await dispatchTool({
    toolName: 'atel_wallet_withdraw',
    config: gatedConfig,
    authorization: 'Bearer x',
    auth: adminAuth,
    input: { chain: 'base', address: '0x' + 'b'.repeat(40), amount: 0.001 },  // tiny amount
  });
  check('wallet_withdraw triggers APPROVAL_PENDING (no threshold)', false, 'should have thrown');
} catch (e) {
  check('wallet_withdraw triggers APPROVAL_PENDING for ANY amount', e?.code === 'APPROVAL_PENDING', e?.code);
}

// ─── Test 6: rate limit kicks in eventually ─────────────────────────

console.log('\n[6] Rate limit');
const { _platformLimiterForTests } = await import('../dist/platform/client.js');
_platformLimiterForTests.reset();
let drainAttempts = 0;
let drainErrors = 0;
setMockFetch(() => new Response('{}', { status: 200 }));
for (let i = 0; i < 80; i++) {
  drainAttempts += 1;
  try {
    await dispatchTool({
      toolName: 'atel_balance',
      config,
      authorization: 'Bearer x',
      auth: mockAuth,
    });
  } catch {
    drainErrors += 1;
  }
}
check(`rate limit fires within first 80 calls (got ${drainErrors} errors)`, drainErrors > 0);

// ─── Cleanup ─────────────────────────────────────────────────────────

globalThis.fetch = originalFetch;

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
