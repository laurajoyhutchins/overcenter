import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCanaryApproval } from '../scripts/owner-approval-canary-receipt.ts';

const environment = { name: 'overcenter-owner-approval' };

test('settlement records an owner rejection as a rejected no-side-effect canary', () => {
  const receipt = classifyCanaryApproval({
    gateJobResult: 'failure',
    evidenceAvailable: true,
    approvals: [{
      state: 'rejected',
      comment: 'Reject test',
      user: { login: 'laurajoyhutchins' },
      environments: [environment],
    }],
    environmentName: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
  });

  assert.deepEqual(receipt, {
    review_state: 'rejected',
    reviewed_by: 'laurajoyhutchins',
    review_comment: 'Reject test',
    outcome: 'rejected_no_side_effect_canary',
  });
});

test('settlement records an owner approval only when the gate job completes', () => {
  const receipt = classifyCanaryApproval({
    gateJobResult: 'success',
    evidenceAvailable: true,
    approvals: [{
      state: 'approved',
      user: { login: 'laurajoyhutchins' },
      environments: [environment],
    }],
    environmentName: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
  });

  assert.equal(receipt.review_state, 'approved');
  assert.equal(receipt.reviewed_by, 'laurajoyhutchins');
  assert.equal(receipt.outcome, 'approved_no_side_effect_canary');
});

test('settlement does not treat an unexpected reviewer as owner approval', () => {
  const receipt = classifyCanaryApproval({
    gateJobResult: 'success',
    evidenceAvailable: true,
    approvals: [{
      state: 'approved',
      user: { login: 'someone-else' },
      environments: [environment],
    }],
    environmentName: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
  });

  assert.equal(receipt.review_state, 'unauthorized');
  assert.equal(receipt.reviewed_by, 'someone-else');
  assert.equal(receipt.outcome, 'reviewer_not_authorized');
});

test('settlement leaves unavailable review evidence unresolved', () => {
  const receipt = classifyCanaryApproval({
    gateJobResult: 'success',
    evidenceAvailable: false,
    approvals: [],
    environmentName: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
  });

  assert.equal(receipt.review_state, 'unavailable');
  assert.equal(receipt.reviewed_by, null);
  assert.equal(receipt.outcome, 'approval_evidence_unavailable');
});
