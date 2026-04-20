import type { AtelMcpConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';

export interface PlatformRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  bearerToken: string;
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
  constructor(private readonly config: AtelMcpConfig) {}

  async request<T>(req: PlatformRequest): Promise<T> {
    const baseUrl = req.path.startsWith('/registry/')
      ? this.config.registryBaseUrl
      : req.path.startsWith('/relay/')
        ? this.config.relayBaseUrl
        : this.config.platformBaseUrl;
    const url = `${baseUrl}${req.path}${normalizeQuery(req.query)}`;
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.bearerToken}`,
      },
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
