import { AtelMcpError } from '../contracts/errors.js';
import type { AtelEnvironmentProfile } from '../config.js';
import type { AtelSession, EnvironmentGuardOptions, PrerequisiteCheckResult, ScopeCheckOptions } from './types.js';

export function assertScopes(session: AtelSession, options: ScopeCheckOptions): void {
  if (options.requireAll?.some((scope) => !session.scopes.includes(scope))) {
    throw new AtelMcpError('FORBIDDEN', 'This tool is not available for the current session.', {
      required: options.requireAll,
      actual: session.scopes,
    });
  }
  if (options.requireAny?.length && !options.requireAny.some((scope) => session.scopes.includes(scope))) {
    throw new AtelMcpError('FORBIDDEN', 'This tool requires a different permission set.', {
      requiredAny: options.requireAny,
      actual: session.scopes,
    });
  }
}

export function assertEnvironment(session: AtelSession, options: EnvironmentGuardOptions): void {
  if (!options.allowed.includes(session.environment)) {
    throw new AtelMcpError('ENVIRONMENT_MISMATCH', 'This tool is not available in the current environment.', {
      allowed: options.allowed,
      actual: session.environment,
    });
  }
}

export function assertRemoteEnvironmentAllowed(
  session: AtelSession,
  allowedRemoteEnvironments: AtelEnvironmentProfile[] = ['production'],
): void {
  if (!allowedRemoteEnvironments.includes(session.environment)) {
    throw new AtelMcpError('ENVIRONMENT_MISMATCH', 'Remote MCP is not enabled for this environment.', {
      allowedRemoteEnvironments,
      actual: session.environment,
    });
  }
}

export async function assertPrerequisite(
  _session: AtelSession,
  check: () => Promise<PrerequisiteCheckResult>,
): Promise<void> {
  const result = await check();
  if (result.ok) return;
  throw new AtelMcpError(result.code, result.message, result.details);
}
