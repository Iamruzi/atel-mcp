/**
 * Approval read tools.
 *
 * The host LLM uses these to:
 *   - poll pending approvals it filed (atel_approval_list)
 *   - check the latest state of a specific approval id (atel_approval_get)
 *
 * There is intentionally NO atel_approval_grant / atel_approval_deny tool.
 * Granting an approval defeats the gate's purpose if the same client that
 * filed it can grant it. The grant must come out-of-band — operator CLI
 * (npm run approval:approve <id>) or dashboard.
 */

import { z } from 'zod';
import { listApprovals, getApproval } from '../approval/gate.js';
import type { ToolExecutionContext } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { AtelMcpError } from '../contracts/errors.js';

const ApprovalIdSchema = z.string().min(1).startsWith('appr-');

export async function atelApprovalList(ctx: ToolExecutionContext) {
  // Approval visibility belongs to the wallet read scope: same trust level
  // as seeing your balance.
  requireScope(ctx, 'wallet.read');
  if (!ctx.config.approvalLogPath) {
    return { approvals: [], hint: 'Approval gate not configured (ATEL_MCP_APPROVAL_LOG_PATH unset).' };
  }
  const approvals = await listApprovals(ctx.config.approvalLogPath, ctx.session.did);
  return { approvals };
}

export async function atelApprovalGet(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'wallet.read');
  const id = ApprovalIdSchema.parse((input as { id?: unknown })?.id);
  if (!ctx.config.approvalLogPath) {
    throw new AtelMcpError(
      'NOT_IMPLEMENTED',
      'Approval gate not configured',
      { id },
      'Set ATEL_MCP_APPROVAL_LOG_PATH on the MCP server to enable.',
    );
  }
  const approval = await getApproval(ctx.config.approvalLogPath, id);
  if (!approval) {
    throw new AtelMcpError('NOT_FOUND', `Approval ${id} not found`, { id });
  }
  if (approval.did !== ctx.session.did) {
    // Don't leak existence of approvals to other DIDs.
    throw new AtelMcpError('NOT_FOUND', `Approval ${id} not found`, { id });
  }
  return approval;
}
