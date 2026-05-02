/**
 * Pin atel_wallet_status semantics.
 *
 * Critical for the onboarding loop — caller polls this after
 * atel_register_user. If the status mapping breaks (e.g. fast-only is
 * misclassified as ready), callers proceed to paid orders before the
 * EVM smart wallet is deployed and get on-chain reverts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { atelWalletStatus } from '../tools/wallet.js';
import type { ToolExecutionContext } from '../server/context.js';

interface MockReq {
  method: string;
  path: string;
}

function makeCtx(balanceResponse: unknown) {
  return {
    session: {
      did: 'did:atel:ed25519:tester',
      scopes: ['wallet.read'],
      environment: 'production',
      bearerToken: 'tok',
      sessionId: 's',
    },
    config: {},
    platform: {
      request: async (_req: MockReq) => balanceResponse,
    },
    emitAudit: async () => {},
  } as unknown as ToolExecutionContext;
}

test('wallet_status: pending when no chain has an address', async () => {
  const result = await atelWalletStatus(makeCtx({ chainAddresses: {} }));
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.chainsReady, []);
  assert.equal(result.chainAddresses.base, null);
  assert.equal(result.chainAddresses.bsc, null);
  assert.equal(result.chainAddresses.fast, null);
  assert.match(result.hint, /5-30 seconds/);
});

test('wallet_status: partial when some but not all chains have addresses', async () => {
  // Common case: Fast addr appears immediately (DID-derived), EVM still
  // deploying.
  const result = await atelWalletStatus(makeCtx({
    chainAddresses: { fast: 'fast1xyz' },
  }));
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.chainsReady, ['fast']);
  assert.match(result.hint, /still deploying/);
  assert.match(result.hint, /base.*bsc/);
});

test('wallet_status: partial reflects exactly which chains are missing in hint', async () => {
  const result = await atelWalletStatus(makeCtx({
    chainAddresses: { base: '0xabc', fast: 'fast1xyz' },
    // bsc missing
  }));
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.chainsReady.sort(), ['base', 'fast']);
  assert.match(result.hint, /bsc/);
});

test('wallet_status: ready when all 3 chains have addresses', async () => {
  const result = await atelWalletStatus(makeCtx({
    chainAddresses: {
      base: '0xbase',
      bsc: '0xbsc',
      fast: 'fast1xyz',
    },
  }));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.chainsReady.sort(), ['base', 'bsc', 'fast']);
  assert.match(result.hint, /Safe to call paid order/);
});

test('wallet_status: empty-string addresses count as missing (defensive)', async () => {
  // Defensive: if platform stores wallets={base: ""} due to a deploy
  // failure mid-state, we should treat that as "still pending" not ready.
  const result = await atelWalletStatus(makeCtx({
    chainAddresses: { base: '', bsc: '', fast: '' },
  }));
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.chainsReady, []);
});

test('wallet_status: tolerates missing chainAddresses field entirely', async () => {
  // Brand-new agent might have NULL wallets in DB (before AutoWallet
  // first writes). balance endpoint may return {} with no chainAddresses.
  const result = await atelWalletStatus(makeCtx({}));
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.chainsReady, []);
});

test('wallet_status: returns the caller DID in response (for confirmation)', async () => {
  const result = await atelWalletStatus(makeCtx({ chainAddresses: {} }));
  assert.equal(result.did, 'did:atel:ed25519:tester');
});
