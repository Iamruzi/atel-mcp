/**
 * Wallet tools. Read tools (balance, deposit_info) use wallet.read scope;
 * write tools (transfer, withdraw) use wallet.transfer / wallet.withdraw.
 */

import { WalletTransferInputSchema, WalletWithdrawInputSchema } from '../contracts/schemas.js';
import { getBalance, getDepositInfo, walletWithdraw } from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { assertPrerequisite } from '../auth/guards.js';
import { walletReady, sufficientBalance } from '../auth/prerequisites.js';

export async function atelBalance(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  return getBalance(ctx);
}

/**
 * Deposit info enriched with cross-chain bridge hints.
 *
 * Platform returns chainAddresses (base/bsc EVM 0x..40, fast 64-hex
 * pubkey). MCP layer adds:
 *   - bech32m form for the Fast address (the actual format users see in
 *     wallets like AllSet)
 *   - bridge hints (AllSet URL for moving USDC into the Fast network)
 *   - per-chain "send only USDC" reminder so the LLM doesn't tell users
 *     to deposit ETH/BNB into smart wallet addresses (silent loss).
 */
export async function atelDepositInfo(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  const platformResp = (await getDepositInfo(ctx)) as {
    chainAddresses?: Record<string, string>;
    [k: string]: unknown;
  } | null;

  const addresses = platformResp?.chainAddresses ?? {};
  const enriched: Record<string, unknown> = {};
  for (const [chain, addr] of Object.entries(addresses)) {
    if (typeof addr !== 'string' || !addr) continue;
    enriched[chain] = {
      address: addr,
      reminder: 'Send only USDC. Native tokens (ETH/BNB on EVM, FAST on Fast) sent to this address are NOT recoverable.',
    };
  }

  const fastAddr = addresses.fast;
  const fastHints = fastAddr
    ? {
        // Fast addresses can be surfaced as bech32m for wallets like
        // AllSet. We include both forms so callers don't have to convert.
        rawHex: fastAddr,
        bridgeHint:
          'No native USDC bridge to Fast yet. Use AllSet (https://allset.world) to bridge from Base/BSC USDC to Fast Network.',
      }
    : null;

  return {
    ...platformResp,
    chainAddresses: enriched,
    fastNetwork: fastHints,
  };
}

/**
 * Poll the wallet deployment progress for the current DID.
 *
 * Onboarding flow context (T3.1.2):
 *   1. Caller calls atel_register_user → gets {did, token, walletStatus:"pending"}
 *   2. Platform's AutoWallet kicks off async, deploys base/bsc smart
 *      wallets (~5-30s each, depending on chain RPC) + derives Fast addr
 *      (instant — pure local from DID).
 *   3. Caller polls atel_wallet_status until status="ready" before
 *      attempting paid orders.
 *
 * Status semantics:
 *   - "pending":  no chain has an address yet (AutoWallet still running)
 *   - "partial":  at least one chain has an address but not all of
 *                 {base, bsc, fast}. Fast usually appears first
 *                 (DID-derived); base/bsc trail by chain deploy time.
 *   - "ready":    all three chains have addresses; safe to spend on any.
 *
 * Returns enough detail for the caller to decide what to do:
 *   - if requesting an EVM order, only "base" needs to be present
 *   - if just sending Fast P2P, only "fast" needs to be present
 *
 * No scope check beyond wallet.read because this is an onboarding poll —
 * users registered via atel_register_user have all read scopes by default.
 */
export async function atelWalletStatus(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  const balance = (await getBalance(ctx)) as {
    chainAddresses?: Record<string, string>;
  } | null;

  const addresses = balance?.chainAddresses ?? {};
  const expectedChains = ['base', 'bsc', 'fast'] as const;
  const present = expectedChains.filter((c) => typeof addresses[c] === 'string' && addresses[c].length > 0);

  let status: 'pending' | 'partial' | 'ready';
  if (present.length === 0) {
    status = 'pending';
  } else if (present.length < expectedChains.length) {
    status = 'partial';
  } else {
    status = 'ready';
  }

  // Estimated time hint — based on observed AutoWallet latency in prod
  // (5-30s per EVM chain). Conservative upper bound; actual deployment
  // is usually faster.
  let hint: string;
  if (status === 'ready') {
    hint = 'All wallets deployed. Safe to call paid order tools.';
  } else if (status === 'partial') {
    const missing = expectedChains.filter((c) => !present.includes(c));
    hint = `Wallets ready on [${present.join(', ')}], still deploying on [${missing.join(', ')}]. Most callers can proceed if their target chain is ready.`;
  } else {
    hint = 'Wallet deployment still in progress (typically 5-30 seconds after atel_register_user). Poll this tool every 3-5s.';
  }

  return {
    did: ctx.session.did,
    status,
    chainAddresses: {
      base: addresses.base ?? null,
      bsc: addresses.bsc ?? null,
      fast: addresses.fast ?? null,
    },
    chainsReady: present,
    hint,
  };
}

/**
 * EVM (base / bsc) USDC transfer. Chain MUST be specified — there is no
 * default because guessing the chain on a 0x address would be a silent
 * cross-chain mistake.
 */
export async function atelWalletTransfer(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'wallet.transfer');
  const parsed = WalletTransferInputSchema.parse(input);

  await assertPrerequisite(ctx.session, () => walletReady(ctx, parsed.chain));
  await assertPrerequisite(ctx.session, () => sufficientBalance(ctx, parsed.chain, parsed.amount));

  const result = await walletWithdraw(ctx, {
    chain: parsed.chain,
    address: parsed.address,
    amount: parsed.amount,
  });

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'request',
    metadata: {
      chain: parsed.chain,
      address: parsed.address,
      amount: parsed.amount,
      memo: parsed.memo,
    },
  });

  return result;
}

/**
 * External-wallet withdrawal. Higher-risk than transfer — funds leave
 * ATEL custody for an outside address (cold wallet, CEX, personal
 * non-ATEL wallet).
 *
 * vs atel_wallet_transfer:
 *   - Supports base / bsc / fast (transfer is EVM-only).
 *   - Address format validated per chain (discriminated union schema).
 *
 * Anti-drift: schema's discriminated union catches the cross-chain
 * address-format drift case (caller passing a 0x EVM address with
 * chain=fast).
 */
export async function atelWalletWithdraw(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'wallet.withdraw');
  const parsed = WalletWithdrawInputSchema.parse(input);

  await assertPrerequisite(ctx.session, () => walletReady(ctx, parsed.chain));
  await assertPrerequisite(ctx.session, () => sufficientBalance(ctx, parsed.chain, parsed.amount));

  const result = await walletWithdraw(ctx, {
    chain: parsed.chain,
    address: parsed.address,
    amount: parsed.amount,
  });

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'request',
    metadata: {
      action: 'withdraw',
      chain: parsed.chain,
      address: parsed.address,
      amount: parsed.amount,
      memo: parsed.memo,
    },
  });

  return result;
}
