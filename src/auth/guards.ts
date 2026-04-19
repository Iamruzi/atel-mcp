import { AtelMcpError } from '../contracts/errors.js';
import type { AtelEnvironmentProfile } from '../config.js';
import type { AtelSession, EnvironmentGuardOptions, PrerequisiteCheckResult, ScopeCheckOptions } from './types.js';

export function assertScopes(session: AtelSession, options: ScopeCheckOptions): void {
  if (options.requireAll?.some((scope) => !session.scopes.includes(scope))) {
    throw new AtelMcpError('FORBIDDEN', 'Session is missing required scopes.', {
      required: options.requireAll,
      actual: session.scopes,
    });
  }
  if (options.requireAny?.length && !options.requireAny.some((scope) => session.scopes.includes(scope))) {
    throw new AtelMcpError('FORBIDDEN', 'Session is missing any acceptable scope.', {
      requiredAny: options.requireAny,
      actual: session.scopes,
    });
  }
}

export function assertEnvironment(session: AtelSession, options: EnvironmentGuardOptions): void {
  if (!options.allowed.includes(session.environment)) {
    throw new AtelMcpError('ENVIRONMENT_MISMATCH', 'Session environment is not allowed for this tool.', {
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
    throw new AtelMcpError('ENVIRONMENT_MISMATCH', 'Remote MCP does not allow this environment.', {
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
