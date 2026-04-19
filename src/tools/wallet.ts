import { getBalance, getDepositInfo } from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { requireScope } from '../server/guards.js';

export async function atelBalance(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  return getBalance(ctx);
}

export async function atelDepositInfo(ctx: ToolExecutionContext) {
  requireScope(ctx, 'wallet.read');
  return getDepositInfo(ctx);
}
