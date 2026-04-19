import { AgentRegisterInputSchema, AgentSearchInputSchema, WhoamiOutputSchema } from '../contracts/schemas.js';
import { registryRegister, registrySearch } from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { requireScope } from '../server/guards.js';

export async function atelWhoami(ctx: ToolExecutionContext) {
  requireScope(ctx, 'identity.read');
  const output = {
    did: ctx.session.did,
    environment: ctx.session.environment,
    scopes: ctx.session.scopes,
  };
  return WhoamiOutputSchema.parse(output);
}

export async function atelAgentRegister(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'contacts.write');
  return registryRegister(ctx, AgentRegisterInputSchema.parse(input));
}

export async function atelAgentSearch(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  return registrySearch(ctx, AgentSearchInputSchema.parse(input));
}
