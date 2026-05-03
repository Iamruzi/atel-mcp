/**
 * Anti-drift suite — each test simulates a typical LLM mistake and asserts
 * the MCP layer catches it BEFORE any chain spend / external mutation, with
 * an actionable hint the LLM can use to self-correct.
 *
 * The whole reason this test file exists: prod incidents where SDK accepted
 * loose inputs (raw vs decimal amounts, fabricated DIDs, wrong chain) and
 * silently failed. Each `test(...)` here corresponds to one such incident
 * pattern; if a test starts failing because we relaxed a check, that's a
 * regression to the original drift case.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atelA2bSearch, atelA2bPurchaseGet, atelA2bLockFunds } from '../tools/a2b.js';
import { atelFastTransfer } from '../tools/fast.js';
import { atelWalletTransfer } from '../tools/wallet.js';
import { atelOrderCreate } from '../tools/order.js';
import { atelMilestoneSubmit, atelMilestoneVerify } from '../tools/milestone.js';
import { atelSendMessage } from '../tools/messaging.js';
import { _resetApprovalStoreCache } from '../approval/gate.js';
import { AtelMcpError } from '../contracts/errors.js';
import type { ToolExecutionContext } from '../server/context.js';

// ─── Test harness ────────────────────────────────────────────────────────

interface MockRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

type MockResponder = (req: MockRequest) => unknown;

interface MockCtxOptions {
  did?: string;
  scopes?: string[];
  responder?: MockResponder;
  approvalLogPath?: string;
  approvalBypassTools?: string[];
}

function makeCtx(opts: MockCtxOptions = {}): ToolExecutionContext {
  const did = opts.did ?? 'did:atel:ed25519:tester';
  const calls: MockRequest[] = [];
  const platform = {
    request: async <T>(req: MockRequest): Promise<T> => {
      calls.push(req);
      const response = opts.responder?.(req);
      if (response === undefined) {
        throw new AtelMcpError('UPSTREAM_ERROR', `No mock response configured for ${req.method} ${req.path}`, {
          path: req.path,
        });
      }
      return response as T;
    },
  };
  const ctx = {
    meta: {
      requestId: 'req-test',
      toolName: 'mock',
    },
    session: {
      did,
      sessionId: 'session-test',
      scopes: opts.scopes ?? ['identity.read', 'wallet.read'],
      environment: 'production',
      bearerToken: 'mock-bearer',
    },
    config: {
      approvalLogPath: opts.approvalLogPath,
      approvalBypassTools: opts.approvalBypassTools ?? ['atel_wallet_transfer', 'atel_fast_transfer'],
    },
    platform,
    executionPlan: { selectedBackend: 'platform-hosted' },
    emitAudit: async () => {},
  } as unknown as ToolExecutionContext;
  // Expose calls for assertions.
  (ctx as unknown as { _calls: MockRequest[] })._calls = calls;
  return ctx;
}

function callsOf(ctx: ToolExecutionContext): MockRequest[] {
  return (ctx as unknown as { _calls: MockRequest[] })._calls;
}

// A 64-zero-byte ed25519 pubkey base58-encodes to 32 '1's. We use this for
// any test that needs a DID-formatted recipient distinct from the test DID.
const DID_ALL_ZERO = 'did:atel:ed25519:' + '1'.repeat(32);

// ─── 1. a2b_search server-clamps limit=30 (the SKILL.md drift case) ─────

test('anti-drift: a2b_search ignores host-supplied limit and forces 30', async () => {
  const ctx = makeCtx({
    scopes: ['a2b.read'],
    responder: () => ({ items: [] }),
  });
  await atelA2bSearch(ctx, { query: 'boxer', limit: 5 });
  const sent = callsOf(ctx)[0];
  assert.equal((sent.body as { limit: number }).limit, 30);
});

// ─── 2. a2b redemption only revealed when status=DELIVERED ──────────────

test('anti-drift: a2b_purchase_get does NOT reveal redemption when status=PENDING', async () => {
  const ctx = makeCtx({
    scopes: ['a2b.read'],
    responder: (req) => {
      if (req.path.includes('/redemption')) {
        // If this endpoint is hit, the gate is broken.
        throw new Error('Redemption reveal MUST NOT be called when status=PENDING');
      }
      return { intent_id: 'intent_123', status: 'PENDING' };
    },
  });
  const result = (await atelA2bPurchaseGet(ctx, { intentId: 'intent_123' })) as { redemption: unknown };
  assert.equal(result.redemption, null);
});

test('anti-drift: a2b_purchase_get reveals redemption only when status=DELIVERED', async () => {
  const ctx = makeCtx({
    scopes: ['a2b.read'],
    responder: (req) => {
      if (req.path.includes('/redemption')) return { code: 'REDEEM-OK' };
      return { intent_id: 'intent_123', status: 'DELIVERED' };
    },
  });
  const result = (await atelA2bPurchaseGet(ctx, { intentId: 'intent_123' })) as {
    redemption: { code?: string };
  };
  assert.equal(result.redemption?.code, 'REDEEM-OK');
});

// ─── 3. fast_transfer rejects EVM 0x address (wrong chain format) ───────

test('anti-drift: fast_transfer rejects 0x-prefixed EVM address (wrong format for Fast)', async () => {
  const ctx = makeCtx({ scopes: ['wallet.transfer'] });
  await assert.rejects(
    () => atelFastTransfer(ctx, { recipient: '0x' + 'a'.repeat(40), amount: 0.01 }),
    (err: unknown) => err instanceof Error,
  );
});

// ─── 4. wallet_transfer rejects 64-hex (Fast) address on EVM chain ──────

test('anti-drift: wallet_transfer rejects 64-char Fast hex on chain=base', async () => {
  const ctx = makeCtx({ scopes: ['wallet.transfer'] });
  await assert.rejects(
    () => atelWalletTransfer(ctx, { chain: 'base', address: 'a'.repeat(64), amount: 0.01 }),
    (err: unknown) => err instanceof Error,
  );
});

// ─── 5. wallet_transfer rejects when chain is missing (no defaulting) ───

test('anti-drift: wallet_transfer rejects missing chain (no silent default)', async () => {
  const ctx = makeCtx({ scopes: ['wallet.transfer'] });
  await assert.rejects(
    () => atelWalletTransfer(ctx, { address: '0x' + 'a'.repeat(40), amount: 0.01 }),
    (err: unknown) => err instanceof Error,
  );
});

// ─── 6. wallet_transfer rejects raw 6-decimal int amount (drift case) ───

test('anti-drift: wallet_transfer rejects raw 6-decimal int amount (>10000 cap)', async () => {
  const ctx = makeCtx({ scopes: ['wallet.transfer'] });
  await assert.rejects(
    () => atelWalletTransfer(ctx, {
      chain: 'base',
      address: '0x' + 'a'.repeat(40),
      // Host LLM thinks "1 USDC" = 1000000 raw — schema cap rejects.
      amount: 1000000,
    }),
    (err: unknown) => err instanceof Error,
  );
});

// ─── 7. fast_transfer self-transfer guard (silent no-op prevention) ─────

test('anti-drift: fast_transfer rejects sending to your own DID', async () => {
  const ctx = makeCtx({
    did: DID_ALL_ZERO,
    scopes: ['wallet.transfer'],
  });
  await assert.rejects(
    () => atelFastTransfer(ctx, { recipient: DID_ALL_ZERO, amount: 0.01 }),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'INVALID_INPUT',
  );
});

// ─── 8. wallet_transfer reports balance gap with chain alternative hint ─

test('anti-drift: insufficient balance hint suggests an alternative chain', async () => {
  const ctx = makeCtx({
    scopes: ['wallet.transfer'],
    responder: (req) => {
      if (req.path === '/account/v1/balance') {
        // base low, bsc has plenty.
        return {
          chainAddresses: { base: '0xaaa', bsc: '0xbbb' },
          chainBalances: { base: 0.1, bsc: 50 },
        };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelWalletTransfer(ctx, {
      chain: 'base',
      address: '0x' + 'b'.repeat(40),
      amount: 5,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'INSUFFICIENT_BALANCE');
      assert.match(err.hint ?? '', /try chain=bsc/i);
      return true;
    },
  );
});

// ─── 9. wallet_transfer with no funds anywhere → top-up hint ────────────

test('anti-drift: insufficient balance with no alternative chain hints at deposit', async () => {
  const ctx = makeCtx({
    scopes: ['wallet.transfer'],
    responder: (req) => {
      if (req.path === '/account/v1/balance') {
        return {
          chainAddresses: { base: '0xaaa', bsc: '0xbbb' },
          chainBalances: { base: 0, bsc: 0 },
        };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelWalletTransfer(ctx, {
      chain: 'base',
      address: '0x' + 'b'.repeat(40),
      amount: 5,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'INSUFFICIENT_BALANCE');
      assert.match(err.hint ?? '', /atel_deposit_info/);
      return true;
    },
  );
});

// ─── 10. wallet_transfer with no chain address yet → walletReady fail ───

test('anti-drift: walletReady catches missing chain address with deploy-pending hint', async () => {
  const ctx = makeCtx({
    scopes: ['wallet.transfer'],
    responder: (req) => {
      if (req.path === '/account/v1/balance') {
        // base address not yet deployed (smart-wallet still deploying).
        return {
          chainAddresses: { bsc: '0xbbb' },
          chainBalances: { bsc: 100 },
        };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelWalletTransfer(ctx, {
      chain: 'base',
      address: '0x' + 'b'.repeat(40),
      amount: 1,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'WALLET_NOT_READY');
      assert.match(err.hint ?? '', /Poll atel_balance/);
      return true;
    },
  );
});

// ─── 11. order_create blocks on offline executor (capability table ok) ──

test('anti-drift: order_create rejects offline executor with capability hint', async () => {
  const executorDid = DID_ALL_ZERO;
  const ctx = makeCtx({
    scopes: ['orders.write'],
    responder: (req) => {
      if (req.path.startsWith('/registry/v1/agent/')) {
        return { online: false, lastSeen: '2026-04-30T00:00:00Z', capabilities: ['coding'] };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelOrderCreate(ctx, {
      executorDid,
      capabilityType: 'coding',
      description: 'test',
      priceUsdc: 1,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'EXECUTOR_OFFLINE');
      assert.match(err.hint ?? '', /atel_agent_search/);
      return true;
    },
  );
});

// ─── 12. order_create blocks on capability mismatch ─────────────────────

test('anti-drift: order_create rejects executor without requested capability', async () => {
  const executorDid = DID_ALL_ZERO;
  const ctx = makeCtx({
    scopes: ['orders.write'],
    responder: (req) => {
      if (req.path.startsWith('/registry/v1/agent/')) {
        // Executor offers translation + writing; caller asks for coding.
        return { online: true, capabilities: ['translation', 'writing'] };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelOrderCreate(ctx, {
      executorDid,
      capabilityType: 'coding',
      description: 'test',
      priceUsdc: 1,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'CAPABILITY_MISMATCH');
      assert.match(err.hint ?? '', /translation.*writing/);
      return true;
    },
  );
});

// ─── 13. send_message blocks fabricated DID (no agent in registry) ──────

test('anti-drift: send_message rejects fabricated DID (404 from registry)', async () => {
  const ctx = makeCtx({
    scopes: ['messages.write'],
    responder: () => {
      // Simulate 404 — adapter returns null on 404, prereq surfaces it.
      throw new Error('404 Not Found');
    },
  });
  await assert.rejects(
    () => atelSendMessage(ctx, { peerDid: DID_ALL_ZERO, text: 'hello' }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'TARGET_NOT_FOUND');
      assert.match(err.hint ?? '', /atel_agent_search/);
      return true;
    },
  );
});

// ─── 14. milestone_verify blocks if milestone not yet submitted ─────────

test('anti-drift: milestone_verify rejects when milestone status=pending (not submitted)', async () => {
  const requesterDid = 'did:atel:ed25519:requester';
  const ctx = makeCtx({
    did: requesterDid,
    scopes: ['milestones.write'],
    responder: (req) => {
      if (req.path.startsWith('/trade/v1/order/') && req.path.endsWith('/milestones')) {
        return [{ index: 0, status: 'pending' }];
      }
      if (req.path.startsWith('/trade/v1/order/')) {
        // getOrder for callerIsRole check.
        return { requesterDid, executorDid: DID_ALL_ZERO };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelMilestoneVerify(ctx, { orderId: 'ord-test', index: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'PREREQUISITE_NOT_MET');
      assert.match(err.message, /must be 'submitted'/);
      return true;
    },
  );
});

// ─── 15. milestone_submit blocks if previous milestone not verified ─────

test('anti-drift: milestone_submit rejects M1 when M0 not yet verified', async () => {
  const executorDid = 'did:atel:ed25519:executor';
  const ctx = makeCtx({
    did: executorDid,
    scopes: ['milestones.write'],
    responder: (req) => {
      if (req.path.startsWith('/trade/v1/order/') && req.path.endsWith('/milestones')) {
        // M0 only submitted, not yet verified.
        return [{ index: 0, status: 'submitted' }];
      }
      if (req.path.startsWith('/trade/v1/order/')) {
        return { status: 'executing', requesterDid: 'did:atel:ed25519:requester', executorDid };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelMilestoneSubmit(ctx, { orderId: 'ord-test', index: 1, content: 'M1 content' }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'PREREQUISITE_NOT_MET');
      assert.match(err.message, /Milestone 0.*must be 'verified'/);
      return true;
    },
  );
});

// ─── 16. a2b_lock_funds enforces walletReady on base specifically ───────

test('anti-drift: a2b_lock_funds requires base wallet (Fast-only user gets clear hint)', async () => {
  const ctx = makeCtx({
    scopes: ['a2b.write'],
    responder: (req) => {
      if (req.path === '/account/v1/balance') {
        // Fast-only user — no base address.
        return {
          chainAddresses: { fast: 'a'.repeat(64) },
          chainBalances: { fast: 100 },
        };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelA2bLockFunds(ctx, { intentId: 'intent_test', amount: 0.5 }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'WALLET_NOT_READY');
      return true;
    },
  );
});

// ─── 17. wallet_transfer + approval gate end-to-end ─────────────────────

test('anti-drift: wallet_transfer with approval gate enabled throws APPROVAL_PENDING first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-anti-drift-'));
  const path = join(dir, 'approvals.jsonl');
  _resetApprovalStoreCache();
  const ctx = makeCtx({
    scopes: ['wallet.transfer'],
    approvalLogPath: path,
    // No bypass — gate is fully active for this test.
    approvalBypassTools: [],
    responder: (req) => {
      if (req.path === '/account/v1/balance') {
        return {
          chainAddresses: { base: '0xaaa' },
          chainBalances: { base: 100 },
        };
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelWalletTransfer(ctx, {
      chain: 'base',
      address: '0x' + 'b'.repeat(40),
      amount: 1,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'APPROVAL_PENDING');
      const details = err.details as { approvalId?: string; summary?: string };
      assert.match(details.approvalId ?? '', /^appr-/);
      assert.match(details.summary ?? '', /1 USDC.*BASE/i);
      return true;
    },
  );
  // The chain spend must NOT have happened — only the balance read.
  const paths = callsOf(ctx).map((c) => c.path);
  assert.ok(!paths.includes('/trade/v1/wallet/withdraw'), 'withdraw must not be called before approval');
});
