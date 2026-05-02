/**
 * Fast Network tools — direct USDC P2P on FastCoop mainnet (no escrow).
 *
 * Backstory: ATEL DIDs are ed25519 keys, which is also the Fast account
 * format — every ATEL user has a Fast address out of the box, no extra
 * KYC / wallet setup. We added these tools because:
 *   - the existing atel_balance is the EVM-only "balance gap" memo case
 *     (it doesn't surface chainBalances.fast, even when present)
 *   - SDK doesn't expose Fast at all; LLMs trying to do Fast P2P had to
 *     call the platform endpoint manually with the right hex format
 *
 * Anti-drift wins this file enforces:
 *   1. chain hard-locked to 'fast' on transfer (server endpoint accepts
 *      base/bsc/fast — without this, LLM might send a hex address with
 *      chain=base and platform silently fails)
 *   2. recipient accepts both DID and 64-char hex; bech32 explicitly
 *      rejected (Fast P2P endpoint can't decode bech32 — see memo)
 *   3. amount in USDC decimal (max 10000) — blocks the raw-int drift
 *      where LLM passes 1000000 thinking it's $1
 *   4. memo is informational only (audit-side); we don't try to encode
 *      it as user_data because Fast's user_data is Option<32-byte hash>
 *      not arbitrary string
 */

import { FastTransferInputSchema } from '../contracts/schemas.js';
import { getBalance, getDepositInfo, walletWithdraw } from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { assertPrerequisite } from '../auth/guards.js';
import { walletReady, sufficientBalance } from '../auth/prerequisites.js';
import { requireApproval } from '../approval/gate.js';
import { AtelMcpError } from '../contracts/errors.js';

// ─── DID → Fast hex address conversion ───────────────────────────────────
//
// ATEL DID format: did:atel:ed25519:<base58 pubkey>. Fast Network expects
// a raw 64-char hex pubkey on its P2P endpoint. We do the conversion in
// MCP so the host LLM doesn't have to (which it would get wrong: base58
// decoding is non-obvious and tg-bot needed two iterations to land it).

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  // bytes is the little-endian numeric representation we build up. It must
  // start empty — initializing with [0] leaks a redundant zero byte and
  // makes the all-zero (32 '1' chars) case decode to 33 bytes instead of 32.
  const bytes: number[] = [];
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 character: '${c}'`);
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Preserve leading-zero bytes encoded as leading '1' chars.
  for (const c of str) {
    if (c !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve any Fast-acceptable recipient (DID or hex) to the 64-char hex
 * format the platform endpoint requires. Throws AtelMcpError with an
 * actionable hint on malformed input.
 */
export function resolveFastHexAddress(recipient: string): string {
  if (/^[0-9a-fA-F]{64}$/.test(recipient)) {
    return recipient.toLowerCase();
  }
  if (recipient.startsWith('did:atel:ed25519:')) {
    const tail = recipient.slice('did:atel:ed25519:'.length);
    let decoded: Uint8Array;
    try {
      decoded = base58Decode(tail);
    } catch (e) {
      throw new AtelMcpError(
        'INVALID_INPUT',
        `Cannot base58-decode DID pubkey: ${(e as Error).message}`,
        { recipient },
        'Verify the DID came from atel_agent_search and was not edited.',
      );
    }
    if (decoded.length !== 32) {
      throw new AtelMcpError(
        'INVALID_INPUT',
        `DID pubkey decoded to ${decoded.length} bytes, expected 32`,
        { recipient, decodedLength: decoded.length },
        'This does not look like an ed25519 ATEL DID. Use atel_agent_search to find a valid one.',
      );
    }
    return bytesToHex(decoded);
  }
  throw new AtelMcpError(
    'INVALID_INPUT',
    'Recipient must be a did:atel:ed25519:... DID or a 64-char hex pubkey',
    { recipient },
    'Fast Network does NOT accept bech32 addresses. Convert via atel_agent_search (returns DID) or pass the raw 64-char hex.',
  );
}

// ─── Tools ───────────────────────────────────────────────────────────────

/**
 * Fast Network USDC balance + address. Reads from the same /account/v1/balance
 * endpoint as atel_balance but pulls only the Fast slice — gives LLM a
 * single-purpose tool to call when it specifically wants to know "do I
 * have Fast USDC". Surfaces a clear hint when the platform balance response
 * doesn't include Fast (the documented gap).
 */
export async function atelFastBalance(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  const balance = (await getBalance(ctx)) as {
    chainBalances?: Record<string, number | string>;
    chainAddresses?: Record<string, string>;
  };
  const fastBalance = balance.chainBalances?.fast;
  const fastAddress = balance.chainAddresses?.fast;
  return {
    chain: 'fast' as const,
    address: fastAddress ?? null,
    balance: fastBalance ?? null,
    available: fastBalance !== undefined && fastBalance !== null,
    hint: fastBalance === undefined
      ? 'Platform balance response missing chainBalances.fast — known gap. Try /trade/v1/wallet/balance?chain=fast directly if needed.'
      : undefined,
  };
}

/**
 * Fast deposit address. Returns the user's own Fast hex address (= DID
 * pubkey) so they can give it to a counterparty for inbound USDC. We
 * derive both from the platform balance response (authoritative) AND from
 * the DID (deterministic) so we can flag any mismatch — defense against
 * a misconfigured platform serving the wrong address.
 */
export async function atelFastDepositAddress(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  const derived = resolveFastHexAddress(ctx.session.did);

  let platformAddress: string | undefined;
  try {
    const deposit = (await getDepositInfo(ctx)) as { chainAddresses?: Record<string, string> };
    platformAddress = deposit.chainAddresses?.fast;
  } catch {
    // Platform deposit-info missing fast is fine — DID derivation is the
    // source of truth for Fast (account = pubkey).
  }

  const mismatch = platformAddress && platformAddress.toLowerCase() !== derived;
  return {
    chain: 'fast' as const,
    address: derived,
    didDerived: derived,
    platformReported: platformAddress ?? null,
    mismatch: mismatch ? true : false,
    hint: mismatch
      ? `Platform reported ${platformAddress} but DID derives to ${derived}. Use the DID-derived value; report the platform mismatch.`
      : 'Fast addresses are 64-char hex (= ed25519 pubkey). bech32 / 0x prefixes are NOT valid here.',
  };
}

/**
 * Fast USDC P2P transfer. High-risk: real fund movement, irreversible.
 * Routes through platform /trade/v1/wallet/withdraw with chain hard-locked
 * to 'fast' (server-side, host can't override).
 *
 * Prereqs (all must pass before any chain spend):
 *   - wallet.transfer scope (high-risk, never default-granted)
 *   - walletReady('fast') — chainAddresses.fast must be present
 *   - sufficientBalance('fast', amount) — no gas buffer (Fast is gas-free)
 *
 * Recipient resolution happens before prereqs so a malformed DID errors
 * out fast without touching balance.
 */
export async function atelFastTransfer(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'wallet.transfer');
  const parsed = FastTransferInputSchema.parse(input);

  const recipientHex = resolveFastHexAddress(parsed.recipient);

  // Don't let a user accidentally send to themselves (silent no-op that
  // burns their attention waiting for a tx that doesn't move funds).
  const ownHex = resolveFastHexAddress(ctx.session.did);
  if (recipientHex === ownHex) {
    throw new AtelMcpError(
      'INVALID_INPUT',
      'Cannot transfer to your own Fast address',
      { recipientHex, ownHex },
      'Pick a different recipient. If you meant to inspect your balance, use atel_fast_balance.',
    );
  }

  await assertPrerequisite(ctx.session, () => walletReady(ctx, 'fast'));
  await assertPrerequisite(ctx.session, () => sufficientBalance(ctx, 'fast', parsed.amount));

  await requireApproval(
    ctx,
    {
      action: 'fast.transfer',
      toolName: 'atel_fast_transfer',
      intentParams: {
        recipient: recipientHex,
        amount: parsed.amount,
      },
      summary: `Fast Network USDC transfer: ${parsed.amount} → ${recipientHex.slice(0, 10)}…${recipientHex.slice(-6)}${parsed.memo ? ` (memo: ${parsed.memo})` : ''}`,
    },
    {
      approvalLogPath: ctx.config.approvalLogPath,
      bypassTools: ctx.config.approvalBypassTools,
    },
  );

  const result = await walletWithdraw(ctx, {
    chain: 'fast',
    address: recipientHex,
    amount: parsed.amount,
  });

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'request',
    metadata: {
      chain: 'fast',
      recipient: recipientHex,
      recipientInputForm: parsed.recipient.startsWith('did:atel:') ? 'did' : 'hex',
      amount: parsed.amount,
      memo: parsed.memo,
    },
  });

  return result;
}
