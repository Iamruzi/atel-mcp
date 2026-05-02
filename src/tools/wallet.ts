/**
 * Wallet tools.
 *
 * Read tools (balance, deposit_info) — wallet.read scope, no fund movement.
 * Write tools (transfer) — wallet.transfer scope AND per-action approval
 * gate (see src/approval/). Two-factor: scope = "host may attempt",
 * approval = "user OK'd this specific action".
 */

import { WalletTransferInputSchema } from '../contracts/schemas.js';
import { getBalance, getDepositInfo, walletWithdraw } from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { assertPrerequisite } from '../auth/guards.js';
import { walletReady, sufficientBalance } from '../auth/prerequisites.js';
import { requireApproval } from '../approval/gate.js';

export async function atelBalance(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  return getBalance(ctx);
}

export async function atelDepositInfo(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  return getDepositInfo(ctx);
}

/**
 * EVM (base / bsc) USDC transfer. Chain MUST be specified — there is no
 * default because guessing the chain on a 0x address would be a silent
 * cross-chain mistake.
 *
 * Approval gate is mandatory: even with wallet.transfer scope, the host
 * must wait for an out-of-band operator approval per action. The host LLM
 * gets APPROVAL_PENDING with the approval id; user approves via dashboard
 * or `npm run approval:approve <id>`; host retries; gate consumes the
 * approval (one-shot) and proceeds.
 */
export async function atelWalletTransfer(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'wallet.transfer');
  const parsed = WalletTransferInputSchema.parse(input);

  await assertPrerequisite(ctx.session, () => walletReady(ctx, parsed.chain));
  await assertPrerequisite(ctx.session, () => sufficientBalance(ctx, parsed.chain, parsed.amount));

  await requireApproval(
    ctx,
    {
      action: 'wallet.transfer',
      toolName: 'atel_wallet_transfer',
      intentParams: {
        chain: parsed.chain,
        address: parsed.address.toLowerCase(),
        amount: parsed.amount,
      },
      summary: `Transfer ${parsed.amount} USDC on ${parsed.chain.toUpperCase()} to ${parsed.address}${parsed.memo ? ` (memo: ${parsed.memo})` : ''}`,
    },
    {
      approvalLogPath: ctx.config.approvalLogPath,
      bypassTools: ctx.config.approvalBypassTools,
    },
  );

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
