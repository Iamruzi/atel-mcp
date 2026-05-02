/**
 * Pin dispute create/resolve behavior + the >=3-reject prereq.
 *
 * If the prereq breaks, host LLM can spam dispute opens after one reject
 * — flooding the arbitrator queue with cases that should have been
 * resolved via direct comms.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { atelDisputeCreate, atelDisputeResolve } from '../tools/dispute.js';
import { DisputeCreateInputSchema, DisputeResolveInputSchema } from '../contracts/schemas.js';
import { AtelMcpError } from '../contracts/errors.js';
import type { ToolExecutionContext } from '../server/context.js';

interface MockReq {
  method: string;
  path: string;
  body?: unknown;
}

function makeCtx(opts: {
  scopes?: string[];
  responder?: (req: MockReq) => unknown;
}) {
  const calls: MockReq[] = [];
  const ctx = {
    meta: { requestId: 'req', toolName: 'dispute' },
    session: {
      did: 'did:atel:ed25519:tester',
      sessionId: 's',
      scopes: opts.scopes ?? ['disputes.read', 'disputes.write'],
      environment: 'production',
      bearerToken: 'tok',
    },
    config: {},
    platform: {
      request: async (req: MockReq) => {
        calls.push(req);
        return opts.responder?.(req);
      },
    },
    emitAudit: async () => {},
  } as unknown as ToolExecutionContext;
  (ctx as unknown as { _calls: MockReq[] })._calls = calls;
  return ctx;
}

const longReason =
  'Executor delivered milestone content that does not match the agreed spec. The tone is wrong, the data sources are wrong, and we have already attempted to clarify three times via milestone reject feedback.';

// ─── Schema gates ───────────────────────────────────────────────────

test('dispute_create schema: rejects reason shorter than 100 chars', () => {
  assert.throws(() => DisputeCreateInputSchema.parse({ orderId: 'ord-x', reason: 'didn\'t work' }));
});

test('dispute_create schema: accepts >=100 char reason', () => {
  const r = DisputeCreateInputSchema.parse({ orderId: 'ord-x', reason: longReason });
  assert.equal(r.orderId, 'ord-x');
});

test('dispute_resolve schema: rejects splitRatio when verdict=split is missing', () => {
  assert.throws(() => DisputeResolveInputSchema.parse({
    disputeId: 'd-1',
    verdict: 'split',
    notes: 'this is a sufficiently long arbitration note for testing',
  }));
});

test('dispute_resolve schema: accepts split verdict with splitRatio', () => {
  const r = DisputeResolveInputSchema.parse({
    disputeId: 'd-1',
    verdict: 'split',
    splitRatio: 0.6,
    notes: 'this is a sufficiently long arbitration note for testing',
  });
  assert.equal(r.verdict, 'split');
  assert.equal(r.splitRatio, 0.6);
});

test('dispute_resolve schema: accepts favor_requester without splitRatio', () => {
  const r = DisputeResolveInputSchema.parse({
    disputeId: 'd-1',
    verdict: 'favor_requester',
    notes: 'this is a sufficiently long arbitration note for testing',
  });
  assert.equal(r.verdict, 'favor_requester');
});

test('dispute_resolve schema: rejects unknown verdict', () => {
  assert.throws(() => DisputeResolveInputSchema.parse({
    disputeId: 'd-1',
    verdict: 'tie',
    notes: 'this is a sufficiently long arbitration note for testing',
  }));
});

test('dispute_resolve schema: rejects splitRatio out of [0,1]', () => {
  assert.throws(() => DisputeResolveInputSchema.parse({
    disputeId: 'd-1',
    verdict: 'split',
    splitRatio: 1.5,
    notes: 'this is a sufficiently long arbitration note for testing',
  }));
  assert.throws(() => DisputeResolveInputSchema.parse({
    disputeId: 'd-1',
    verdict: 'split',
    splitRatio: -0.1,
    notes: 'this is a sufficiently long arbitration note for testing',
  }));
});

test('dispute_resolve schema: rejects notes shorter than 20 chars', () => {
  assert.throws(() => DisputeResolveInputSchema.parse({
    disputeId: 'd-1',
    verdict: 'favor_executor',
    notes: 'too short',
  }));
});

// ─── Reject-count prereq ────────────────────────────────────────────

test('dispute_create: rejects when no milestone has >=3 rejections', async () => {
  const ctx = makeCtx({
    responder: (req) => {
      if (req.path.endsWith('/milestones')) {
        // Highest reject count is 2 — below threshold.
        return [{ index: 0, status: 'submitted', rejectCount: 2 }];
      }
      return null;
    },
  });
  await assert.rejects(
    () => atelDisputeCreate(ctx, { orderId: 'ord-x', reason: longReason }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'PREREQUISITE_NOT_MET');
      assert.match(err.message, />=3 rejections/);
      return true;
    },
  );
});

test('dispute_create: passes when a milestone hit >=3 rejections', async () => {
  const ctx = makeCtx({
    responder: (req) => {
      if (req.path.endsWith('/milestones')) {
        return [
          { index: 0, status: 'verified', rejectCount: 1 },
          { index: 1, status: 'submitted', rejectCount: 3 },
        ];
      }
      if (req.path.startsWith('/dispute/v1/remote/open')) {
        return { disputeId: 'disp-1', status: 'open' };
      }
      return null;
    },
  });
  const result = await atelDisputeCreate(ctx, { orderId: 'ord-x', reason: longReason }) as { disputeId: string };
  assert.equal(result.disputeId, 'disp-1');
});

test('dispute_create: tolerates snake_case reject_count in milestone payload', async () => {
  const ctx = makeCtx({
    responder: (req) => {
      if (req.path.endsWith('/milestones')) {
        return [{ index: 0, status: 'submitted', reject_count: 4 }];
      }
      if (req.path.startsWith('/dispute/v1/remote/open')) {
        return { disputeId: 'disp-2' };
      }
      return null;
    },
  });
  const result = await atelDisputeCreate(ctx, { orderId: 'ord-x', reason: longReason });
  assert.ok(result);
});

// ─── Resolve handler ────────────────────────────────────────────────

test('dispute_resolve: requires dispute.resolve scope (not just disputes.write)', async () => {
  const ctx = makeCtx({
    scopes: ['disputes.write'], // intentionally NOT dispute.resolve
  });
  await assert.rejects(
    () => atelDisputeResolve(ctx, {
      disputeId: 'd-1',
      verdict: 'favor_requester',
      notes: 'this is a sufficiently long arbitration note for testing',
    }),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'FORBIDDEN',
  );
});

test('dispute_resolve: forwards verdict to platform /dispute/v1/remote/{id}/resolve', async () => {
  // Audit fix (2026-05-03): platform-side path is /dispute/v1/remote/{id}/resolve
  // (RegisterRemoteRoutes), NOT /dispute/v1/{id}/resolve (which would be the
  // admin-only mount that's not exposed). The remote endpoint requires
  // ATEL_ARBITRATOR_DIDS allowlist on platform side and currently returns 501
  // pending splitRatio→absolute-amount conversion plumbing.
  const ctx = makeCtx({
    scopes: ['dispute.resolve'],
    responder: (req) => {
      if (req.path === '/dispute/v1/remote/d-1/resolve') {
        return { disputeId: 'd-1', verdict: 'favor_executor', settled: true };
      }
      return null;
    },
  });
  const result = await atelDisputeResolve(ctx, {
    disputeId: 'd-1',
    verdict: 'favor_executor',
    notes: 'work was acceptable; reject feedback was unwarranted per evidence',
  }) as { settled: boolean };
  assert.equal(result.settled, true);
});
