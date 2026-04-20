import { AtelMcpError } from '../contracts/errors.js';
import type { AtelScope } from '../contracts/scopes.js';
import type { ToolExecutionContext } from './context.js';

export function requireScope(ctx: ToolExecutionContext, scope: AtelScope): void {
  if (!ctx.session.scopes.includes(scope)) {
    throw new AtelMcpError('FORBIDDEN', 'This action is not permitted for the current session.', { scope });
  }
}

export function requireProduction(ctx: ToolExecutionContext): void {
  if (ctx.session.environment !== 'production' || ctx.config.environment !== 'production') {
    throw new AtelMcpError('ENVIRONMENT_MISMATCH', 'This action is only available in production-backed sessions.', {
      sessionEnvironment: ctx.session.environment,
      configEnvironment: ctx.config.environment,
    });
  }
}
