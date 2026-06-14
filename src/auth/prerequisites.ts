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
import { getBalance, getAgent, getOrder, listMilestones } from '../platform/adapters.js';

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
/**
 * Order must be in one of the allowed statuses before a state-mutating action.
 * Without this, host LLM can call atel_milestone_submit on a `cancelled` order
 * (silent state-machine violation, audit log shows tool.invoked but server
 * confused).
 */
export async function orderInStatus(
  ctx: ToolExecutionContext,
  orderId: string,
  allowedStatuses: string[],
): Promise<PrerequisiteCheckResult> {
  try {
    // Platform's GET /trade/v1/order/:id returns Go-style PascalCase
    // ({Status, OrderID}) while POST /trade/v1/remote/order returns
    // lowercase camelCase ({status, orderId}). Read both so the prereq
    // works regardless of which path landed it.
    const order = (await getOrder(ctx, orderId)) as { status?: string; Status?: string } | null;
    if (!order) {
      return {
        ok: false,
        code: 'TARGET_NOT_FOUND',
        message: `Order ${orderId} not found`,
        hint: 'Verify the orderId via atel_order_list.',
      };
    }
    const current = order.status ?? order.Status;
    if (!allowedStatuses.includes(current ?? '')) {
      return {
        ok: false,
        code: 'PREREQUISITE_NOT_MET',
        message: `Order is in status=${current}, requires one of [${allowedStatuses.join(',')}]`,
        details: { orderId, current, allowed: allowedStatuses },
        hint: `Use atel_order_timeline ${orderId} to see how it got to ${current}.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'PREREQUISITE_NOT_MET',
      message: `Cannot check order status: ${(e as Error).message}`,
    };
  }
}

/**
 * Caller must be the order's executor (for accept/submit) or requester (for
 * verify/reject). Server-side enforcement so host LLM can't fake DID role.
 */
export async function callerIsRole(
  ctx: ToolExecutionContext,
  orderId: string,
  role: 'requester' | 'executor',
): Promise<PrerequisiteCheckResult> {
  try {
    const order = (await getOrder(ctx, orderId)) as
      | { requesterDid?: string; executorDid?: string; requester_did?: string; executor_did?: string;
          RequesterDID?: string; ExecutorDID?: string }
      | null;
    if (!order) {
      return {
        ok: false,
        code: 'TARGET_NOT_FOUND',
        message: `Order ${orderId} not found`,
      };
    }
    // Triple-fallback: camelCase (POST remote), snake_case (some legacy
    // paths), PascalCase (Go default JSON marshaling, GET /trade/v1/order/:id).
    const expected = role === 'requester'
      ? (order.requesterDid ?? order.requester_did ?? order.RequesterDID)
      : (order.executorDid ?? order.executor_did ?? order.ExecutorDID);
    if (expected !== ctx.session.did) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: `This action is restricted to the order ${role}`,
        details: { yourDid: ctx.session.did, expectedDid: expected, role },
        hint: `Only the ${role} (${expected}) can do this. Switch identity or pick another order.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'PREREQUISITE_NOT_MET',
      message: `Cannot verify role: ${(e as Error).message}`,
    };
  }
}

/**
 * Milestone N can only be submitted after milestone N-1 is verified. Without
 * this, host LLM tries to submit M2 before M1 verifies → undefined platform
 * behavior (we observed cases where milestones get verified out of order).
 */
export async function previousMilestoneVerified(
  ctx: ToolExecutionContext,
  orderId: string,
  index: number,
): Promise<PrerequisiteCheckResult> {
  if (index === 0) return { ok: true };
  try {
    const milestones = (await listMilestones(ctx, orderId)) as Array<{ index?: number; status?: string }> | { milestones?: Array<{ index?: number; status?: string }> };
    const list = Array.isArray(milestones) ? milestones : (milestones.milestones ?? []);
    const prev = list.find((m) => m.index === index - 1);
    if (!prev) {
      return {
        ok: false,
        code: 'PREREQUISITE_NOT_MET',
        message: `Previous milestone ${index - 1} does not exist`,
        hint: `Use atel_milestone_list ${orderId} to see what milestones are defined.`,
      };
    }
    if (prev.status !== 'verified') {
      return {
        ok: false,
        code: 'PREREQUISITE_NOT_MET',
        message: `Milestone ${index - 1} is in status=${prev.status}, must be 'verified' before submitting milestone ${index}`,
        details: { previousIndex: index - 1, previousStatus: prev.status },
        hint: prev.status === 'submitted'
          ? `Wait for requester to verify M${index - 1} (or atel_milestone_verify yourself if you are the requester).`
          : `Submit + verify M${index - 1} first.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'PREREQUISITE_NOT_MET',
      message: `Cannot check milestone history: ${(e as Error).message}`,
    };
  }
}

/**
 * Milestone must be in 'submitted' status before verify/reject. Without this,
 * host LLM verifies a milestone that hasn't been submitted yet (audit shows
 * verified=true but executor never delivered).
 */
export async function milestoneIsSubmitted(
  ctx: ToolExecutionContext,
  orderId: string,
  index: number,
): Promise<PrerequisiteCheckResult> {
  try {
    const milestones = (await listMilestones(ctx, orderId)) as Array<{ index?: number; status?: string }> | { milestones?: Array<{ index?: number; status?: string }> };
    const list = Array.isArray(milestones) ? milestones : (milestones.milestones ?? []);
    const m = list.find((mm) => mm.index === index);
    if (!m) {
      return {
        ok: false,
        code: 'PREREQUISITE_NOT_MET',
        message: `Milestone ${index} does not exist on order ${orderId}`,
        hint: `Use atel_milestone_list ${orderId} to see valid indexes.`,
      };
    }
    if (m.status !== 'submitted') {
      return {
        ok: false,
        code: 'PREREQUISITE_NOT_MET',
        message: `Milestone ${index} is in status=${m.status}, must be 'submitted' to verify/reject`,
        details: { milestoneIndex: index, current: m.status },
        hint: m.status === 'verified' ? 'This milestone is already verified.' : `Wait for executor to submit M${index} via atel_milestone_submit.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'PREREQUISITE_NOT_MET',
      message: `Cannot check milestone status: ${(e as Error).message}`,
    };
  }
}

/**
 * T3.6.1 — Dispute creation requires that at least one milestone has been
 * rejected `>= threshold` times. Without this gate, host LLM can open a
 * dispute on the very first reject (or even with no rejects at all),
 * filling the arbitration queue with noise.
 *
 * Default threshold is 3 (matches platform's auto-arbitration trigger).
 */
export async function disputeRejectThresholdMet(
  ctx: ToolExecutionContext,
  orderId: string,
  threshold = 3,
): Promise<PrerequisiteCheckResult> {
  try {
    const milestones = (await listMilestones(ctx, orderId)) as
      | Array<{ rejectCount?: number; reject_count?: number }>
      | { milestones?: Array<{ rejectCount?: number; reject_count?: number }> };
    const list = Array.isArray(milestones) ? milestones : (milestones.milestones ?? []);
    let maxRejects = 0;
    for (const m of list) {
      const n = Number(m.rejectCount ?? m.reject_count ?? 0);
      if (n > maxRejects) maxRejects = n;
    }
    if (maxRejects < threshold) {
      return {
        ok: false,
        code: 'PREREQUISITE_NOT_MET',
        message: `dispute requires a milestone with >=${threshold} rejections (highest seen: ${maxRejects})`,
        details: { orderId, threshold, observedMax: maxRejects },
        hint: `Reject the failing milestone (atel_milestone_reject) until rejectCount reaches ${threshold}, then dispute. Below this threshold, use direct comms — disputes go to arbitrator queue.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: 'PREREQUISITE_NOT_MET',
      message: `cannot check milestone rejection history: ${(e as Error).message}`,
    };
  }
}

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
