import type { AtelMcpConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';

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

export class PlatformClient {
  /**
   * `defaultIdempotencyKey` is wired from the MCP request meta in
   * `buildRequestContext`. Every state-mutating POST automatically gets an
   * `idempotency-key` header — so retries (host LLM resends, network
   * blips, dispatch loop) won't create duplicate orders / messages /
   * milestones at the platform.
   *
   * Without this, the only place idempotency-key flowed was the
   * linked-runtime forwarder; the main MCP→platform path was wide open
   * to duplicates. Caught during cross-repo audit 2026-05-02.
   */
  constructor(
    private readonly config: AtelMcpConfig,
    private readonly defaultIdempotencyKey?: string,
  ) {}

  async request<T>(req: PlatformRequest): Promise<T> {
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

    const response = await fetch(url, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });

    const payload = await parseJson(response);
    if (!response.ok) {
      throw new AtelMcpError('UPSTREAM_ERROR', 'The ATEL platform could not complete this request.', {
        status: response.status,
        path: req.path,
        payload,
      });
    }

    return payload as T;
  }
}
