/**
 * DID-Sig auth scheme — backup channel for headless agents.
 *
 * Why this exists: the OAuth challenge-poll flow assumes a browser at some
 * point in the loop. Agents running fully headless (CI, daemon, embedded
 * runtime) can't do that. DID-Sig lets such an agent sign a short-lived
 * payload with its ed25519 key and present it directly as the
 * Authorization header. The MCP server doesn't verify the signature locally
 * — it forwards to the platform's /auth/v1/verify, which has the
 * authoritative key registry and rate-limiting. On success, platform
 * returns a normal session envelope (same shape as Bearer introspection).
 *
 * Header format: `ATEL-DID-Sig <base64-encoded JSON payload>`
 *
 * Payload shape (what the client builds before base64):
 *   {
 *     "did":   "did:atel:ed25519:<base58 pubkey>",
 *     "ts":    <unix seconds>,
 *     "nonce": "<random 16-byte hex>",
 *     "sig":   "<base64 signature over (did|ts|nonce)>"
 *   }
 *
 * Bearer flow is unchanged. This scheme is purely additive.
 */

import type { AtelMcpConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';
import type {
  AuthIntrospectionClient,
} from './introspection.js';
import type { PlatformSessionEnvelope, RemoteBearerClaims } from './types.js';
import type { AtelScope } from '../contracts/scopes.js';

export const DID_SIG_SCHEME = 'ATEL-DID-Sig';

export function isDidSigAuthorization(value?: string | null): boolean {
  if (!value) return false;
  return value.trim().toLowerCase().startsWith(DID_SIG_SCHEME.toLowerCase() + ' ');
}

export function extractDidSigPayload(value?: string | null): string {
  const raw = value?.trim();
  if (!raw) throw new AtelMcpError('UNAUTHORIZED', 'Authentication is required.');
  const match = new RegExp(`^${DID_SIG_SCHEME}\\s+(.+)$`, 'i').exec(raw);
  if (!match?.[1]) {
    throw new AtelMcpError(
      'UNAUTHORIZED',
      `${DID_SIG_SCHEME} authorization is missing the signed payload.`,
      undefined,
      `Expected: \`Authorization: ${DID_SIG_SCHEME} <base64 payload>\`. See docs for the payload format.`,
    );
  }
  return match[1].trim();
}

interface DidSigVerifyResponse extends PlatformSessionEnvelope {
  bearerToken?: string;
}

/**
 * Verifies a DID-Sig payload by forwarding to the platform's /auth/v1/verify
 * endpoint and returns RemoteBearerClaims compatible with the Bearer
 * introspection chain.
 *
 * The returned claims include the platform-issued bearerToken so downstream
 * tool calls (which use ctx.session.bearerToken to call platform endpoints)
 * still work — the DID-Sig is exchanged for a bearer token at session
 * resolution time, then everything else uses the standard path.
 */
export class DidSigIntrospectionClient implements AuthIntrospectionClient {
  constructor(private readonly config: AtelMcpConfig) {}

  /**
   * NOTE: the `token` parameter here is the base64 DID-Sig payload, not a
   * bearer token. We keep the AuthIntrospectionClient signature so this
   * client slots into the same dispatch chain as PlatformAuthIntrospectionClient.
   */
  async introspectBearerToken(token: string): Promise<RemoteBearerClaims> {
    const response = await fetch(`${this.config.platformBaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheme: DID_SIG_SCHEME, payload: token }),
    });

    const body = (await response.json().catch(() => null)) as DidSigVerifyResponse | null;

    if (!response.ok || !body?.did) {
      throw new AtelMcpError(
        'UNAUTHORIZED',
        'DID-signed authorization could not be verified by the platform.',
        { status: response.status, payload: body },
        'Common causes: clock skew (>5min), reused nonce, expired ts. Re-sign with a fresh ts/nonce and retry.',
      );
    }

    const now = Math.floor(Date.now() / 1000);
    return {
      sub: body.did,
      did: body.did,
      env: this.parseEnvironment(body.environment),
      scopes: this.parseScopes(body.scopes),
      sessionId: body.sessionId || `did-sig:${body.did}`,
      issuedAt: body.issuedAt ?? now,
      expiresAt: body.expiresAt ?? now + 3600,
      clientId: body.clientId || 'atel-mcp-did-sig',
      // Platform issues a short-lived bearer at verify time so subsequent
      // platform calls (made by tool handlers) still authenticate normally.
      // If the platform stops returning bearerToken, DID-Sig becomes useful
      // only for tools that don't call platform — tighten via a check here.
      bearerToken: body.bearerToken,
    } as RemoteBearerClaims & { bearerToken?: string };
  }

  private parseEnvironment(value: PlatformSessionEnvelope['environment']) {
    if (value === 'production' || value === 'local-test' || value === 'custom') return value;
    return this.config.environment;
  }

  private parseScopes(value: PlatformSessionEnvelope['scopes']): AtelScope[] {
    if (!Array.isArray(value) || value.length === 0) return this.config.defaultRemoteScopes;
    return value.filter((entry): entry is AtelScope => typeof entry === 'string') as AtelScope[];
  }
}

/**
 * Composite client: routes Bearer to the existing platform introspection
 * chain, ATEL-DID-Sig to the DID verify endpoint. Both return the same
 * RemoteBearerClaims shape so dispatch / tool handlers don't care which
 * channel was used.
 */
export class CompositeAuthIntrospectionClient implements AuthIntrospectionClient {
  constructor(
    private readonly bearer: AuthIntrospectionClient,
    private readonly didSig: AuthIntrospectionClient,
  ) {}

  async introspectBearerToken(token: string): Promise<RemoteBearerClaims> {
    // The session resolver hands us the token portion (after the scheme
    // word). For Bearer that's the JWT; for DID-Sig it's the base64
    // payload. To know which path to take, we'd need the original scheme.
    // Instead we let the resolver pre-tag the token — see resolveSession
    // in session.ts which prefixes DID-Sig tokens with a sentinel.
    if (token.startsWith(DID_SIG_TOKEN_SENTINEL)) {
      return this.didSig.introspectBearerToken(token.slice(DID_SIG_TOKEN_SENTINEL.length));
    }
    return this.bearer.introspectBearerToken(token);
  }
}

/** Internal sentinel — see CompositeAuthIntrospectionClient. */
export const DID_SIG_TOKEN_SENTINEL = '\x00did-sig:';
