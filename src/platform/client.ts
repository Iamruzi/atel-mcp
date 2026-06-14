import type { AtelMcpConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';
import { recordPlatformRequest } from '../server/metrics.js';

export interface PlatformRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  bearerToken: string;
  /**
   * Per-request override for the idempotency key. Most callers should leave
   * this unset and let PlatformClient's default (set from the MCP request
   * meta) flow through. Override only for explicit fan-out cases that need
   * a child key distinct from the parent request id.
   */
  idempotencyKey?: string;
  /** Identifier for per-DID rate limit. Falls back to bearerToken hash if unset. */
  rateLimitKey?: string;
}

function normalizeQuery(query?: PlatformRequest['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const raw = params.toString();
  return raw ? `?${raw}` : '';
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * T8.5 — In-memory token-bucket rate limiter, per key (typically per DID).
 * Caps a single misbehaving host from hammering platform if it loops on
 * a tool call. Process-local, so HA scale-out gets N×capacity — fine for
 * v1 since the goal is "block one runaway client", not "enforce global
 * fairness".
 */
class TokenBucketLimiter {
  private buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  constructor(
    private readonly capacity: number = 60, // tokens per key
    private readonly refillPerSec: number = 10,
  ) {}

  /** Returns true if request should proceed; false if rate-limited. */
  tryConsume(key: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(key, b);
    }
    const elapsedSec = (now - b.lastRefillMs) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.lastRefillMs = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Test-only: drop all bucket state. */
  reset(): void {
    this.buckets.clear();
  }
}

const platformLimiter = new TokenBucketLimiter();
export const _platformLimiterForTests = platformLimiter;

/**
 * T8.4 + T8.6 — retry with backoff on transient errors, fail fast on
 * client errors.
 *
 * Retry policy:
 *   - Network failures (TypeError from fetch / abort): retry up to 3 times
 *   - 5xx HTTP responses: retry up to 3 times
 *   - 408 Request Timeout / 429 Rate Limit: retry up to 3 times
 *   - 4xx other than 408/429: NO retry (caller bug, retrying won't fix)
 *   - 2xx: success, no retry
 *
 * Backoff: 200ms, 800ms, 2400ms (exponential, jittered ±20%).
 *
 * NOT retried: requests with idempotency-key are already retry-safe at the
 * platform side; we still apply the same retry rules — duplicates are
 * collapsed by platform's idempotency table.
 */
const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class PlatformClient {
  /**
   * `defaultIdempotencyKey` is wired from the MCP request meta in
   * `buildRequestContext`. Every state-mutating POST automatically gets an
   * `idempotency-key` header — so retries (host LLM resends, network
   * blips, dispatch loop) won't create duplicate orders / messages /
   * milestones at the platform.
   *
   * `defaultRateLimitKey` is wired from the session DID. Rate limit
   * MUST be per-identity, not per-request — otherwise a misbehaving
   * client gets fresh capacity on every loop iteration (no actual
   * limit). Audit caught this 2026-05-03 pre-push.
   */
  constructor(
    private readonly config: AtelMcpConfig,
    private readonly defaultIdempotencyKey?: string,
    private readonly defaultRateLimitKey?: string,
  ) {}

  async request<T>(req: PlatformRequest): Promise<T> {
    // T8.5: per-identity rate-limit on the way in. Defaults to session
    // DID; falls back to a generic "anonymous" bucket if neither
    // explicit key nor DID available (pre-auth path).
    const limitKey = req.rateLimitKey ?? this.defaultRateLimitKey ?? 'anonymous';
    if (!platformLimiter.tryConsume(limitKey)) {
      throw new AtelMcpError(
        'UPSTREAM_ERROR',
        'rate-limited locally to protect platform',
        { rateLimitKey: limitKey, capacity: 60, refillPerSec: 10 },
        'You are calling MCP→platform too fast. Back off ~1s and retry. If you see this often, your tool loop has a bug.',
      );
    }

    const baseUrl = req.path.startsWith('/registry/')
      ? this.config.registryBaseUrl
      : req.path.startsWith('/relay/')
        ? this.config.relayBaseUrl
        : this.config.platformBaseUrl;
    const url = `${baseUrl}${req.path}${normalizeQuery(req.query)}`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${req.bearerToken}`,
    };

    // Inject idempotency-key on mutating requests. GETs are idempotent by
    // HTTP semantics; including the header on them is harmless but
    // pollutes platform logs with redundant data.
    if (req.method === 'POST') {
      const key = req.idempotencyKey ?? this.defaultIdempotencyKey;
      if (key) {
        headers['idempotency-key'] = key;
      }
    }

    const init: RequestInit = {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    };

    let lastErr: unknown;
    let lastStatus = 0;
    let lastPayload: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, init);
        const payload = await parseJson(response);
        if (response.ok) {
          recordPlatformRequest(req.path, '2xx');
          return payload as T;
        }
        lastStatus = response.status;
        lastPayload = payload;
        const statusClass: '4xx' | '5xx' = response.status >= 500 ? '5xx' : '4xx';
        recordPlatformRequest(req.path, statusClass);
        if (!RETRYABLE_STATUSES.has(response.status)) {
          // 4xx-other → caller bug, throw immediately.
          throw new AtelMcpError('UPSTREAM_ERROR', 'The ATEL platform could not complete this request.', {
            status: response.status,
            path: req.path,
            payload,
          });
        }
        // 5xx / 408 / 429 → retry path.
      } catch (err) {
        if (err instanceof AtelMcpError) throw err; // non-retryable, surface
        lastErr = err;
        recordPlatformRequest(req.path, 'error');
      }
      if (attempt < MAX_RETRIES) {
        const baseMs = 200 * Math.pow(3, attempt); // 200, 600, 1800
        const jitter = baseMs * (0.8 + Math.random() * 0.4); // ±20%
        await sleep(jitter);
      }
    }

    // Exhausted retries.
    throw new AtelMcpError(
      'UPSTREAM_ERROR',
      'The ATEL platform could not complete this request after retries.',
      { status: lastStatus, path: req.path, payload: lastPayload, networkError: lastErr instanceof Error ? lastErr.message : undefined, attempts: MAX_RETRIES + 1 },
      'Platform appears unavailable. Wait a few seconds and try again. Persistent failures should be reported to ops.',
    );
  }
}
