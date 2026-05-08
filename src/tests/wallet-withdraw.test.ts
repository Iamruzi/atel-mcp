/**
 * Pin atel_wallet_withdraw behavior — the highest-risk write tool.
 *
 * Failure mode we MUST guard against: schema slips a wrong-format
 * address through (e.g. 0x EVM address with chain=fast) → on-chain
 * revert OR worse, funds sent to a mis-derived address.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { atelWalletWithdraw } from '../tools/wallet.js';
import { AtelMcpError } from '../contracts/errors.js';
import type { ToolExecutionContext } from '../server/context.js';

interface MockReq {
  method: string;
  path: string;
  body?: unknown;
}

function makeCtx(opts: {
  scopes?: string[];
  responder?: (req: MockReq) => unknown;
}) {
  const calls: MockReq[] = [];
  const ctx = {
    meta: { requestId: 'req-test', toolName: 'atel_wallet_withdraw' },
    session: {
      did: 'did:atel:ed25519:tester',
      sessionId: 's',
      scopes: opts.scopes ?? ['wallet.withdraw'],
      environment: 'production',
      bearerToken: 'tok',
    },
    config: {},
    platform: {
      request: async (req: MockReq) => {
        calls.push(req);
        return opts.responder?.(req);
      },
    },
    executionPlan: { selectedBackend: 'platform-hosted' },
    emitAudit: async () => {},
  } as unknown as ToolExecutionContext;
  (ctx as unknown as { _calls: MockReq[] })._calls = calls;
  return ctx;
}

const callsOf = (ctx: ToolExecutionContext) => (ctx as unknown as { _calls: MockReq[] })._calls;

const goodEvmAddr = '0x' + 'a'.repeat(40);
const goodFastAddr = 'a'.repeat(64);

// ─── Schema discriminated union ─────────────────────────────────────

test('wallet_withdraw: rejects EVM address with chain=fast (cross-chain format mismatch)', async () => {
  const ctx = makeCtx({
    responder: (req) => {
      if (req.path === '/account/v1/balance') return { chainAddresses: { fast: 'x'.repeat(64) }, chainBalances: { fast: 100 } };
      return null;
    },
  });
  await assert.rejects(
    () => atelWalletWithdraw(ctx, { chain: 'fast', address: goodEvmAddr, amount: 1 }),
    (err: unknown) => err instanceof Error,
  );
  // Schema rejection must happen before any platform call.
  assert.equal(callsOf(ctx).length, 0);
});

test('wallet_withdraw: rejects 64-hex Fast address with chain=base', async () => {
  const ctx = makeCtx({
    responder: (req) => {
      if (req.path === '/account/v1/balance') return { chainAddresses: { base: '0xaaa' }, chainBalances: { base: 100 } };
      return null;
    },
  });
  await assert.rejects(
    () => atelWalletWithdraw(ctx, { chain: 'base', address: goodFastAddr, amount: 1 }),
    (err: unknown) => err instanceof Error,
  );
  assert.equal(callsOf(ctx).length, 0);
});

test('wallet_withdraw: rejects raw 6-decimal amount (>10000 cap, anti-drift)', async () => {
  const ctx = makeCtx({});
  await assert.rejects(
    () => atelWalletWithdraw(ctx, { chain: 'base', address: goodEvmAddr, amount: 1000000 }),
    (err: unknown) => err instanceof Error,
  );
});

test('wallet_withdraw: rejects when chain is missing (no implicit default)', async () => {
  const ctx = makeCtx({});
  await assert.rejects(
    () => atelWalletWithdraw(ctx, { address: goodEvmAddr, amount: 1 }),
    (err: unknown) => err instanceof Error,
  );
});

test('wallet_withdraw: rejects unknown chain (must be base/bsc/fast)', async () => {
  const ctx = makeCtx({});
  await assert.rejects(
    () => atelWalletWithdraw(ctx, { chain: 'ethereum', address: goodEvmAddr, amount: 1 }),
    (err: unknown) => err instanceof Error,
  );
});

// ─── Scope guard ────────────────────────────────────────────────────

test('wallet_withdraw: requires wallet.withdraw scope (not .transfer)', async () => {
  const ctx = makeCtx({
    scopes: ['wallet.transfer'], // intentionally NOT .withdraw
  });
  await assert.rejects(
    () => atelWalletWithdraw(ctx, { chain: 'base', address: goodEvmAddr, amount: 1 }),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'FORBIDDEN',
  );
});

// ─── Prereqs run before approval ────────────────────────────────────

test('wallet_withdraw: walletReady prereq blocks before any approval activity', async () => {
  const ctx = makeCtx({
    responder: (req) => {
      // No `base` address → walletReady fails.
      if (req.path === '/account/v1/balance') return { chainAddresses: { bsc: '0xbbb' }, chainBalances: { bsc: 100 } };
      return null;
    },
  });
  await assert.rejects(
    () => atelWalletWithdraw(ctx, { chain: 'base', address: goodEvmAddr, amount: 1 }),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'WALLET_NOT_READY',
  );
});

test('wallet_withdraw: insufficientBalance returns hint with chain alternative', async () => {
  const ctx = makeCtx({
    responder: (req) => {
      if (req.path === '/account/v1/balance') return {
        chainAddresses: { base: '0xaaa', bsc: '0xbbb' },
        chainBalances: { base: 0.1, bsc: 50 },
      };
      return null;
    },
  });
  await assert.rejects(
    () => atelWalletWithdraw(ctx, { chain: 'base', address: goodEvmAddr, amount: 5 }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'INSUFFICIENT_BALANCE');
      assert.match(err.hint ?? '', /try chain=bsc/i);
      return true;
    },
  );
});

// ─── Happy path: scope passes + balance OK + platform forwarded ─────

test('wallet_withdraw: forwards to platform /trade/v1/wallet/withdraw-jwt', async () => {
  const ctx = makeCtx({
    responder: (req) => {
      if (req.path === '/account/v1/balance') return { chainAddresses: { base: '0xaaa' }, chainBalances: { base: 100 } };
      if (req.path === '/trade/v1/wallet/withdraw-jwt') return { txHash: '0xdeadbeef', status: 'submitted' };
      return null;
    },
  });
  const result = await atelWalletWithdraw(ctx, {
    chain: 'base',
    address: goodEvmAddr,
    amount: 5,
    memo: 'cold storage',
  });
  assert.deepEqual(result, { txHash: '0xdeadbeef', status: 'submitted' });
  // Verify the platform was hit with the right body.
  const withdrawCall = callsOf(ctx).find((c) => c.path === '/trade/v1/wallet/withdraw-jwt');
  assert.ok(withdrawCall);
  assert.deepEqual(withdrawCall!.body, {
    chain: 'base',
    address: goodEvmAddr,
    amount: 5,
  });
});
