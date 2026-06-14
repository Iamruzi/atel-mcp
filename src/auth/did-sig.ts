/**
 * DID-Sig auth scheme — backup channel for headless agents.
 *
 * Why this exists: the OAuth challenge-poll flow assumes a browser at some
 * point in the loop. Agents running fully headless (CI, daemon, embedded
 * runtime) can't do that. DID-Sig lets such an agent sign a short-lived
 * envelope with its ed25519 key and present it directly as the
 * Authorization header. MCP doesn't verify the signature locally — it
 * forwards to platform's /auth/v1/did-sig (which reuses the same
 * VerifySignedRequest infrastructure SDK already uses). Platform returns
 * a JWT bearer token that flows through the standard introspection chain.
 *
 * Header format: `ATEL-DID-Sig <base64-encoded JSON envelope>`
 *
 * Envelope (the JSON the client builds before base64-encoding):
 *   {
 *     "did":       "did:atel:ed25519:<base58 pubkey>",
 *     "payload":   { "nonce": "<random hex>" },   // any object; nonce strongly recommended
 *     "timestamp": "2026-05-02T10:00:00.000Z",     // RFC3339, must be within ±5min of platform clock
 *     "signature": "<base64 ed25519 signature over sortedJSON({did, payload, timestamp})>"
 *   }
 *
 * Note: this matches platform's existing SignedRequest envelope (same
 * canonical-JSON signing rules SDK uses for /trade/v1/order signed POSTs).
 * Reusing the format means `auth.SerializePayload` on platform validates
 * the same bytes the SDK already signs — one less protocol surface to
 * maintain.
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

interface DidSigVerifyResponse {
  /** Bearer JWT issued by platform — flows into ctx.session.bearerToken. */
  token?: string;
  did?: string;
  environment?: PlatformSessionEnvelope['environment'];
  scopes?: PlatformSessionEnvelope['scopes'];
  sessionId?: string;
  expiresAt?: number;
}

interface DidSigEnvelope {
  did: string;
  payload: unknown;
  timestamp: string;
  signature: string;
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
   * NOTE: the `token` parameter here is the base64-encoded DID-Sig
   * envelope (already stripped of the `ATEL-DID-Sig ` scheme prefix by
   * `parseAuthorization` + the sentinel-routing in
   * CompositeAuthIntrospectionClient). We keep the
   * AuthIntrospectionClient signature so this client slots into the same
   * dispatch chain as PlatformAuthIntrospectionClient.
   */
  async introspectBearerToken(token: string): Promise<RemoteBearerClaims> {
    // Step 1: base64-decode → JSON parse → expect SignedRequest envelope.
    let envelope: DidSigEnvelope;
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded) as Partial<DidSigEnvelope>;
      if (
        typeof parsed.did !== 'string' ||
        typeof parsed.signature !== 'string' ||
        typeof parsed.timestamp !== 'string' ||
        parsed.payload === undefined
      ) {
        throw new Error('envelope missing required fields (did, payload, timestamp, signature)');
      }
      envelope = parsed as DidSigEnvelope;
    } catch (e) {
      throw new AtelMcpError(
        'UNAUTHORIZED',
        `${DID_SIG_SCHEME} payload is not a valid base64-encoded SignedRequest envelope`,
        { error: (e as Error).message },
        `Build envelope as JSON: {did, payload:{nonce}, timestamp:RFC3339, signature:base64}, then base64-encode and put in \`Authorization: ${DID_SIG_SCHEME} <base64>\`.`,
      );
    }

    // Step 2: forward verbatim to platform /auth/v1/did-sig (the new
    // endpoint added in the platform-side T6.3 commit). Platform reuses
    // VerifySignedRequest to validate ts window + DID parse + ed25519
    // signature, then issues a JWT bearer.
    const response = await fetch(`${this.config.platformBaseUrl}/auth/v1/did-sig`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });

    const body = (await response.json().catch(() => null)) as DidSigVerifyResponse | null;

    if (!response.ok || !body?.token || !body?.did) {
      throw new AtelMcpError(
        'UNAUTHORIZED',
        'DID-signed authorization could not be verified by the platform.',
        { status: response.status, payload: body },
        'Common causes: clock skew (>5min from platform), bad signature, malformed DID. Re-sign with a fresh timestamp and retry.',
      );
    }

    const now = Math.floor(Date.now() / 1000);
    return {
      sub: body.did,
      did: body.did,
      env: this.parseEnvironment(body.environment),
      scopes: this.parseScopes(body.scopes),
      sessionId: body.sessionId || `did-sig:${body.did}`,
      issuedAt: now,
      expiresAt: body.expiresAt ?? now + 3600,
      clientId: 'atel-mcp-did-sig',
      // Platform's `token` field is the JWT we use as bearer for
      // downstream platform calls (ctx.session.bearerToken).
      bearerToken: body.token,
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
