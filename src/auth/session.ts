import type { RemoteBearerClaims, SessionResolverInput, AtelSession } from './types.js';
import type { AuthIntrospectionClient } from './introspection.js';
import { AtelMcpError } from '../contracts/errors.js';
import {
  DID_SIG_SCHEME,
  DID_SIG_TOKEN_SENTINEL,
  extractDidSigPayload,
  isDidSigAuthorization,
} from './did-sig.js';

export function parseBearerToken(value?: string | null): string {
  const raw = value?.trim();
  if (!raw) throw new AtelMcpError('UNAUTHORIZED', 'Authentication is required.');
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match?.[1]) {
    throw new AtelMcpError(
      'UNAUTHORIZED',
      'Authentication must use a Bearer token or ATEL-DID-Sig.',
      undefined,
      `Use \`Authorization: Bearer <token>\` or \`Authorization: ${DID_SIG_SCHEME} <payload>\`.`,
    );
  }
  return match[1].trim();
}

/**
 * Token-side normalization: returns the raw token for Bearer, or a
 * sentinel-prefixed DID-Sig payload for the alternate scheme. Downstream
 * CompositeAuthIntrospectionClient uses the prefix to route.
 */
export function parseAuthorization(value?: string | null): string {
  if (isDidSigAuthorization(value)) {
    return DID_SIG_TOKEN_SENTINEL + extractDidSigPayload(value);
  }
  return parseBearerToken(value);
}

export function toAtelSession(token: string, claims: RemoteBearerClaims): AtelSession {
  if (!claims.did?.startsWith('did:atel:')) {
    throw new AtelMcpError('UNAUTHORIZED', 'Authenticated session is not linked to a valid ATEL identity.');
  }
  // For DID-Sig sessions, the token field on the session must be the
  // platform-issued bearer that came back in the verify response — NOT
  // the DID-Sig payload. Tool handlers use ctx.session.bearerToken to call
  // platform endpoints; those endpoints expect a real bearer, not a base64
  // DID payload.
  const claimsWithBearer = claims as RemoteBearerClaims & { bearerToken?: string };
  const bearerForPlatformCalls = claimsWithBearer.bearerToken ?? stripDidSigSentinel(token);
  return {
    subject: claims.sub,
    did: claims.did,
    environment: claims.env,
    scopes: claims.scopes,
    bearerToken: bearerForPlatformCalls,
    sessionId: claims.sessionId,
    expiresAt: claims.expiresAt,
    clientId: claims.clientId,
  };
}

function stripDidSigSentinel(token: string): string {
  return token.startsWith(DID_SIG_TOKEN_SENTINEL) ? token.slice(DID_SIG_TOKEN_SENTINEL.length) : token;
}

export async function resolveSession(
  input: SessionResolverInput,
  deps: { auth: AuthIntrospectionClient },
): Promise<AtelSession> {
  const token = parseAuthorization(input.authorization);
  const claims = await deps.auth.introspectBearerToken(token);
  return toAtelSession(token, claims);
}
