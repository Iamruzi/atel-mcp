import test from 'node:test';
import assert from 'node:assert/strict';
import { milestoneRejectAuditTypeFromOutcome } from '../tools/milestone.js';

test('milestoneRejectAuditTypeFromOutcome maps platform auto-arbitration outcomes', () => {
  assert.equal(milestoneRejectAuditTypeFromOutcome('arbitration_passed'), 'milestone.arbitration_passed');
  assert.equal(milestoneRejectAuditTypeFromOutcome('arbitration_failed'), 'milestone.arbitration_failed');
  assert.equal(milestoneRejectAuditTypeFromOutcome('rejected'), 'milestone.rejected');
  assert.equal(milestoneRejectAuditTypeFromOutcome('anything-else'), 'milestone.rejected');
});
