import type { RemoteBearerClaims, SessionResolverInput, AtelSession } from './types.js';
import type { AuthIntrospectionClient } from './introspection.js';
import { AtelMcpError } from '../contracts/errors.js';

export function parseBearerToken(value?: string | null): string {
  const raw = value?.trim();
  if (!raw) throw new AtelMcpError('UNAUTHORIZED', 'Authentication is required.');
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match?.[1]) throw new AtelMcpError('UNAUTHORIZED', 'Authentication must use a Bearer token.');
  return match[1].trim();
}

export function toAtelSession(token: string, claims: RemoteBearerClaims): AtelSession {
  if (!claims.did?.startsWith('did:atel:')) {
    throw new AtelMcpError('UNAUTHORIZED', 'Authenticated session is not linked to a valid ATEL identity.');
  }
  return {
    subject: claims.sub,
    did: claims.did,
    environment: claims.env,
    scopes: claims.scopes,
    bearerToken: token,
    sessionId: claims.sessionId,
    expiresAt: claims.expiresAt,
    clientId: claims.clientId,
  };
}

export async function resolveSession(
  input: SessionResolverInput,
  deps: { auth: AuthIntrospectionClient },
): Promise<AtelSession> {
  const token = parseBearerToken(input.authorization);
  const claims = await deps.auth.introspectBearerToken(token);
  return toAtelSession(token, claims);
}
