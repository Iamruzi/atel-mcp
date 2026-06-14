/**
 * Capability registry cache.
 *
 * Pulls the canonical capability list + alias map from
 * platform GET /capability/v1/standard (added in atel-platform commit
 * for T6.6) and caches it for the lifetime of the MCP process.
 *
 * Why cache process-wide: the data is effectively static (changing
 * `Standard` or `aliases` in atel-platform's capability package requires
 * a platform redeploy). Re-fetching on every order_create would waste a
 * round-trip and add platform dependency to a hot path.
 *
 * Why fall back to a hardcoded list: if platform is briefly unreachable
 * during MCP startup we don't want to refuse all order_create calls.
 * The fallback mirrors the production `Standard` list at the time of
 * writing — drift is OK; if platform adds a new capability, MCP simply
 * doesn't know about it (until restart) but the platform-side check
 * (handleCreateOrder line 313 capability check) is the authoritative
 * gate that catches mismatches.
 */

import type { AtelMcpConfig } from '../config.js';

export interface CapabilityRegistry {
  /** Canonical capability names (e.g. "coding", "writing"). */
  capabilities: string[];
  /** Aliases map: input → canonical (e.g. "code" → "coding"). */
  aliases: Record<string, string>;
}

/**
 * Hardcoded fallback. Mirrors atel-platform/internal/capability/normalize.go
 * at the time of writing. If platform diverges, MCP's view goes stale
 * until next restart — platform handleCreateOrder remains the
 * authoritative validator either way.
 */
const FALLBACK_REGISTRY: CapabilityRegistry = {
  capabilities: [
    'coding',
    'research',
    'translation',
    'data',
    'writing',
    'ai',
    'automation',
    'assistant',
    'testing',
    'general',
  ],
  aliases: {
    code: 'coding',
    development: 'coding',
    programming: 'coding',
    dev: 'coding',
    analyze: 'research',
    analysis: 'research',
    investigate: 'research',
    translate: 'translation',
    translating: 'translation',
    copywriting: 'writing',
    write: 'writing',
    content: 'writing',
    'data-analysis': 'data',
    'market-data': 'data',
    market_data: 'data',
    'ai-agent': 'ai',
    bot: 'ai',
    automate: 'automation',
    script: 'automation',
    help: 'assistant',
    support: 'assistant',
    qa: 'testing',
    test: 'testing',
    task: 'general',
    other: 'general',
  },
};

let cached: CapabilityRegistry | undefined;
let cachePromise: Promise<CapabilityRegistry> | undefined;

/**
 * Fetch the registry from platform (or return the cached value).
 * Concurrent callers during startup share the same in-flight promise so
 * we don't fan out N fetches.
 */
export async function getCapabilityRegistry(config: AtelMcpConfig): Promise<CapabilityRegistry> {
  if (cached) return cached;
  if (cachePromise) return cachePromise;

  cachePromise = (async () => {
    try {
      const response = await fetch(`${config.platformBaseUrl.replace(/\/+$/, '')}/capability/v1/standard`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as Partial<CapabilityRegistry>;
      if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
        throw new Error('platform returned empty capabilities list');
      }
      cached = {
        capabilities: body.capabilities,
        aliases: body.aliases ?? {},
      };
      return cached;
    } catch (err) {
      // Fallback mode: we still serve traffic, just with the static list.
      // Log so operators notice if it persists.
      console.error(`[atel-mcp] capability registry fetch failed, using fallback: ${(err as Error).message}`);
      cached = FALLBACK_REGISTRY;
      return cached;
    } finally {
      cachePromise = undefined;
    }
  })();

  return cachePromise;
}

/**
 * Validate a host-supplied capability string against the registry.
 *
 * Returns:
 *   - { ok: true, normalized: 'coding' } when input is canonical or a known alias
 *   - { ok: false, hint: '...' } otherwise — hint includes the full list
 */
export function validateCapability(
  registry: CapabilityRegistry,
  input: string,
): { ok: true; normalized: string } | { ok: false; hint: string; suggestion?: string } {
  const trimmed = String(input ?? '').trim().toLowerCase();
  if (!trimmed) {
    return {
      ok: false,
      hint: `capabilityType is required. Valid values: ${registry.capabilities.join(', ')}.`,
    };
  }
  if (registry.capabilities.includes(trimmed)) {
    return { ok: true, normalized: trimmed };
  }
  const aliased = registry.aliases[trimmed];
  if (aliased && registry.capabilities.includes(aliased)) {
    return { ok: true, normalized: aliased };
  }
  // Best-effort suggestion: return the closest known string by simple
  // prefix/contains match. Cheap and good enough for a hint.
  const suggestion = registry.capabilities.find((c) => c.startsWith(trimmed) || trimmed.startsWith(c))
    ?? Object.keys(registry.aliases).find((a) => a.startsWith(trimmed) || trimmed.startsWith(a));
  return {
    ok: false,
    suggestion,
    hint: `Unknown capability "${input}". Valid values: ${registry.capabilities.join(', ')}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
  };
}

/** Test-only: drop the cached value so the next call re-fetches. */
export function _resetCapabilityCache(): void {
  cached = undefined;
  cachePromise = undefined;
}

/** Test-only: read the in-memory fallback (no platform fetch). */
export function _getFallbackRegistry(): CapabilityRegistry {
  return FALLBACK_REGISTRY;
}
