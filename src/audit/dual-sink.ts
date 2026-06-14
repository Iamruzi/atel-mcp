/**
 * Dual audit sink — JSONL primary + platform secondary.
 *
 * Ordering matters: JSONL is "source of truth", so its write must complete
 * BEFORE the platform write starts. If we did them in parallel, a JSONL
 * write failure could be masked by a successful platform write, and we'd
 * lose the on-host record. Sequential makes the semantics obvious.
 *
 * The platform sink is best-effort and never throws (see platform-sink.ts),
 * so a platform outage is invisible to the dispatch path.
 */

import type { AuditEvent } from '../contracts/audit.js';
import type { AuditSink } from '../server/context.js';

export class DualAuditSink implements AuditSink {
  constructor(
    private readonly primary: AuditSink,
    private readonly secondary: AuditSink | undefined,
  ) {}

  async emit(event: AuditEvent): Promise<void> {
    // Primary first, sequentially. If primary fails, throw — we don't want
    // to silently lose audit rows on the host where the action happened.
    await this.primary.emit(event);
    if (this.secondary) {
      // Secondary is best-effort; its emit() promises not to throw, but
      // wrap defensively in case a future implementation regresses.
      try {
        await this.secondary.emit(event);
      } catch (error) {
        console.error(
          `[atel-mcp] secondary audit sink threw (should never happen): ${(error as Error).message}`,
        );
      }
    }
  }
}
