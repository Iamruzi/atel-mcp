/**
 * Reusable prerequisite checks for MCP tools.
 *
 * These wrap typical "I want to do X — has the world set up correctly?" checks
 * so individual tool handlers can compose them in one line:
 *
 *   await assertPrerequisite(session, () => walletReady(ctx, 'fast'));
 *   await assertPrerequisite(session, () => targetExists(ctx, target));
 *   await assertPrerequisite(session, () => sufficientBalance(ctx, 'base', amount));
 *
 * Each check returns a structured PrerequisiteCheckResult — never throws — so
 * dispatch can audit the rejection cleanly. Errors carry actionable hints so
 * the calling LLM can self-correct (the whole point of doing this in MCP
 * instead of hoping LLM read SKILL.md).
 *
 * Convention: read from platform via ctx, never side-effect, fast (<200ms).
 */

import type { ToolExecutionContext } from '../server/context.js';
import type { PrerequisiteCheckResult } from './types.js';
import { getBalance, getAgent } from '../platform/adapters.js';

/**
 * Wallet on the given chain must be deployed and ready before any chain
 * mutation (transfer/withdraw/escrow). Race condition we observed in prod:
 * Agent registers → AutoWallet still deploying base SA (5-30s) → host calls
 * atel_balance and gets 0 → user thinks "no money" but money is in EOA fallback.
 */
export async function walletReady(
  ctx: ToolExecutionContext,
  chain: 'base' | 'bsc' | 'fast',
): Promise<PrerequisiteCheckResult> {
  try {
    const balance = await getBalance(ctx);
    const addresses = (balance as { chainAddresses?: Record<string, string> }).chainAddresses ?? {};
    const addr = addresses[chain];
    if (!addr) {
      return {
        ok: false,
        code: 'WALLET_NOT_READY',
        message: `Smart wallet on chain=${chain} not deployed yet`,
        details: { chain, knownAddresses: Object.keys(addresses) },
        hint: `Wallet deployment is async (5-30s). Poll atel_balance until chainAddresses.${chain} appears.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'WALLET_NOT_READY',
      message: `Cannot read wallet status: ${(e as Error).message}`,
      hint: 'Platform may be unavailable. Retry in a few seconds.',
    };
  }
}

/**
 * Sufficient on-chain balance check before transfer/withdraw/escrow_create.
 * `amount` is the USDC amount (decimal). `gasBufferRatio` defaults to 5%
 * for EVM chains; fast network has zero gas so 0%.
 */
export async function sufficientBalance(
  ctx: ToolExecutionContext,
  chain: 'base' | 'bsc' | 'fast',
  amount: number,
  gasBufferRatio = chain === 'fast' ? 0 : 0.05,
): Promise<PrerequisiteCheckResult> {
  try {
    const balance = await getBalance(ctx);
    const balances = (balance as { chainBalances?: Record<string, number> }).chainBalances ?? {};
    const have = Number(balances[chain] ?? 0);
    const need = amount * (1 + gasBufferRatio);
    if (have < need) {
      // Find a chain that has enough — give LLM an actionable hint.
      const alternative = Object.entries(balances).find(
        ([c, v]) => c !== chain && Number(v) >= need,
      );
      const hint = alternative
        ? `${chain.toUpperCase()} has ${have} USDC, need ${need.toFixed(6)}. Try chain=${alternative[0]} where you have ${alternative[1]} USDC.`
        : `${chain.toUpperCase()} has ${have} USDC, need ${need.toFixed(6)}. Top up via atel_deposit_info first.`;
      return {
        ok: false,
        code: 'INSUFFICIENT_BALANCE',
        message: `Insufficient ${chain.toUpperCase()} balance`,
        details: { chain, have, need, gasBufferRatio },
        hint,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'PREREQUISITE_NOT_MET',
      message: `Balance check failed: ${(e as Error).message}`,
    };
  }
}

/**
 * Target DID must exist in registry before send_message / order_create / transfer.
 * Without this check, host's LLM can fabricate a DID and the message goes into
 * a dead-letter relay queue (silent failure observed in prod).
 */
export async function targetExists(
  ctx: ToolExecutionContext,
  targetDid: string,
): Promise<PrerequisiteCheckResult> {
  if (!targetDid.startsWith('did:atel:')) {
    return {
      ok: false,
      code: 'TARGET_NOT_FOUND',
      message: `Invalid DID format: ${targetDid}`,
      hint: 'DIDs must start with `did:atel:ed25519:` followed by base58-encoded pubkey. Use atel_agent_search to find a real agent.',
    };
  }
  try {
    const agent = await getAgent(ctx, targetDid);
    if (!agent) {
      return {
        ok: false,
        code: 'TARGET_NOT_FOUND',
        message: `Agent ${targetDid} not in registry`,
        hint: 'Use atel_agent_search to find existing agents. Do not invent DIDs.',
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'TARGET_NOT_FOUND',
      message: `Cannot verify target: ${(e as Error).message}`,
      hint: 'Use atel_agent_search to verify the target DID exists.',
    };
  }
}

/**
 * Executor must be online + have the requested capability before order_create.
 * Without this: order goes to an offline / wrong-skill executor → expires → user
 * waits + frustration.
 */
export async function executorReady(
  ctx: ToolExecutionContext,
  executorDid: string,
  capability: string,
): Promise<PrerequisiteCheckResult> {
  try {
    const agent = (await getAgent(ctx, executorDid)) as
      | { online?: boolean; lastSeen?: string; capabilities?: Array<string | { type: string }> }
      | null;
    if (!agent) {
      return {
        ok: false,
        code: 'TARGET_NOT_FOUND',
        message: `Executor ${executorDid} not in registry`,
        hint: 'Use atel_agent_search to find a real executor.',
      };
    }
    if (agent.online === false) {
      return {
        ok: false,
        code: 'EXECUTOR_OFFLINE',
        message: `Executor ${executorDid} is offline`,
        details: { lastSeen: agent.lastSeen },
        hint: `Executor last seen: ${agent.lastSeen ?? 'unknown'}. Use atel_agent_search to find an online one with capability=${capability}.`,
      };
    }
    const caps = (agent.capabilities ?? []).map((c) => (typeof c === 'string' ? c : c.type));
    if (!caps.includes(capability)) {
      return {
        ok: false,
        code: 'CAPABILITY_MISMATCH',
        message: `Executor does not have capability=${capability}`,
        details: { available: caps, requested: capability },
        hint: `Executor only handles: [${caps.join(', ')}]. Pick another executor via atel_agent_search.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'PREREQUISITE_NOT_MET',
      message: `Executor check failed: ${(e as Error).message}`,
    };
  }
}
