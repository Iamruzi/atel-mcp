import { readFile } from 'node:fs/promises';
import type { AuditEvent } from '../contracts/audit.js';
import type { AtelMcpConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';

export interface StoredAuditEvent extends AuditEvent {
  id: string;
  createdAt: string;
}

async function loadAuditEvents(config: AtelMcpConfig): Promise<StoredAuditEvent[]> {
  if (!config.auditLogPath) throw new AtelMcpError('PREREQUISITE_NOT_MET', 'Audit records are not available in this environment.', { missing: 'auditLogPath' });
  try {
    const raw = await readFile(config.auditLogPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredAuditEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AtelMcpError('NOT_FOUND', 'Audit records are unavailable right now.', { reason: message });
  }
}

/**
 * Try the platform's /audit/v1/mcp/by-* endpoint first when read is enabled
 * and a token is configured. Returns null on any failure (including network
 * errors, 4xx, malformed body) so the caller falls back to JSONL — keeps
 * the read path strictly additive: platform availability never breaks
 * existing flows.
 */
async function queryPlatform(
  config: AtelMcpConfig,
  did: string,
  scope: 'order' | 'session' | 'request',
  id: string,
  limit: number,
): Promise<StoredAuditEvent[] | null> {
  if (!config.auditPlatformReadEnabled) return null;
  if (!config.auditPlatformIngestToken) return null;
  const path = scope === 'order'
    ? `/audit/v1/mcp/by-order/${encodeURIComponent(id)}`
    : scope === 'session'
      ? `/audit/v1/mcp/by-session/${encodeURIComponent(id)}`
      : `/audit/v1/mcp/by-request/${encodeURIComponent(id)}`;
  const url = `${config.platformBaseUrl.replace(/\/+$/, '')}${path}?did=${encodeURIComponent(did)}&limit=${limit}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.auditPlatformIngestToken}`,
      },
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { events?: StoredAuditEvent[] } | null;
    if (!body || !Array.isArray(body.events)) return null;
    return body.events;
  } catch {
    return null;
  }
}

export async function queryAuditByOrder(config: AtelMcpConfig, did: string, orderId: string, limit: number) {
  const platform = await queryPlatform(config, did, 'order', orderId, limit);
  if (platform !== null) return platform;
  const events = await loadAuditEvents(config);
  return events
    .filter((event) => event.orderId === orderId && event.did === did)
    .slice(-limit)
    .reverse();
}

export async function queryAuditBySession(config: AtelMcpConfig, did: string, sessionId: string, limit: number) {
  const platform = await queryPlatform(config, did, 'session', sessionId, limit);
  if (platform !== null) return platform;
  const events = await loadAuditEvents(config);
  return events
    .filter((event) => event.sessionId === sessionId && event.did === did)
    .slice(-limit)
    .reverse();
}

export async function queryAuditByRequest(config: AtelMcpConfig, did: string, requestId: string, limit: number) {
  const platform = await queryPlatform(config, did, 'request', requestId, limit);
  if (platform !== null) return platform;
  const events = await loadAuditEvents(config);
  return events
    .filter((event) => event.requestId === requestId && event.did === did)
    .slice(-limit)
    .reverse();
}
