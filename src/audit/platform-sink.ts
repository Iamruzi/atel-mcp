/**
 * Platform audit ingest sink.
 *
 * Best-effort POST of each audit event to the platform's mcp_audit_log
 * ingest endpoint. The point: stop forcing operators to grep JSONL on the
 * MCP host when they want to look up "what did DID X do this week" — the
 * platform DB is already where every other audit lives.
 *
 * Failure semantics: this sink NEVER throws. Network blips, 5xx, and
 * upstream-unavailable all log + return silently so the JSONL primary keeps
 * working and the tool dispatch path is never blocked by audit upstream.
 *
 * Field alignment: events sent here are the same shape as JSONL (so platform
 * can store them as-is), plus `mcpInstance` for de-dup if MCP runs HA.
 */

import type { AtelMcpConfig } from '../config.js';
import type { AuditEvent } from '../contracts/audit.js';
import type { AuditSink } from '../server/context.js';

interface IngestPayload extends AuditEvent {
  mcpInstance: string;
  ingestedAt: string;
}

class PlatformAuditSink implements AuditSink {
  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string | undefined,
    private readonly mcpInstance: string,
  ) {}

  async emit(event: AuditEvent): Promise<void> {
    const payload: IngestPayload = {
      ...event,
      mcpInstance: this.mcpInstance,
      ingestedAt: new Date().toISOString(),
    };
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        // Don't read the body — keep the failure path cheap. Operators can
        // grep the JSONL primary if they need the event content.
        console.error(
          `[atel-mcp] platform audit ingest non-2xx: ${response.status} ${response.statusText} (event ${event.type} for ${event.requestId})`,
        );
      }
    } catch (error) {
      // Network failure / DNS / TLS / etc — JSONL primary still has the row.
      console.error(
        `[atel-mcp] platform audit ingest error: ${(error as Error).message} (event ${event.type} for ${event.requestId})`,
      );
    }
  }
}

export function createPlatformAuditSink(config: AtelMcpConfig): AuditSink | undefined {
  if (!config.auditPlatformIngestEnabled) return undefined;
  const endpoint = `${config.platformBaseUrl.replace(/\/+$/, '')}/audit/v1/mcp/ingest`;
  return new PlatformAuditSink(endpoint, config.auditPlatformIngestToken, config.mcpInstance);
}
