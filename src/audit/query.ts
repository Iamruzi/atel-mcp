import { readFile } from 'node:fs/promises';
import type { AuditEvent } from '../contracts/audit.js';
import type { AtelMcpConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';

export interface StoredAuditEvent extends AuditEvent {
  id: string;
  createdAt: string;
}

async function loadAuditEvents(config: AtelMcpConfig): Promise<StoredAuditEvent[]> {
  if (!config.auditLogPath) throw new AtelMcpError('PREREQUISITE_NOT_MET', 'ATEL_MCP_AUDIT_LOG_PATH is not configured');
  try {
    const raw = await readFile(config.auditLogPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredAuditEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AtelMcpError('NOT_FOUND', `Unable to read audit log: ${message}`);
  }
}

export async function queryAuditByOrder(config: AtelMcpConfig, did: string, orderId: string, limit: number) {
  const events = await loadAuditEvents(config);
  return events
    .filter((event) => event.orderId === orderId && event.did === did)
    .slice(-limit)
    .reverse();
}

export async function queryAuditBySession(config: AtelMcpConfig, did: string, sessionId: string, limit: number) {
  const events = await loadAuditEvents(config);
  return events
    .filter((event) => event.sessionId === sessionId && event.did === did)
    .slice(-limit)
    .reverse();
}
