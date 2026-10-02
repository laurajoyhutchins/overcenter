import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectAdvanceResult,
  projectSubmitResult,
} from '../src/authority/project-protocol.ts';

test('project advance result excludes transport envelope metadata', () => {
  const receipt = {
    schema: 'overcenter-project-advance/v1',
    command: 'project.advance',
    transport: 'github-actions-job-rerun',
    repository_id: 42,
    repository_full_name: 'owner/repo',
    command_source_sha: 'a'.repeat(40),
    command_run_id: 100,
    command_run_attempt: 2,
    authority_ref: 'refs/overcenter/state',
    authority_head: 'authority:abc',
    state: 'AGENT_EXECUTION_REQUIRED' as const,
    obligation_id: 'work:one',
    run_id: 'run:one',
    claimed_revision: 'authority:before',
    assignment_sha256: 'b'.repeat(64),
    candidate_branch: 'overcenter/candidate/run:one',
    candidate_branch_base_sha: 'c'.repeat(40),
    dispatch: {
      schema: 'overcenter-judgment-frontier/v1' as const,
      route: 'reasoning-required' as const,
      reason_code: 'OPEN_ENDED_SOURCE_REMEDIATION' as const,
      evidence_predicates: ['packet.kind=source-change'],
    },
    receipt_digest: 'd'.repeat(64),
  };

  assert.deepEqual(projectAdvanceResult(receipt), {
    authority_head: 'authority:abc',
    state: 'AGENT_EXECUTION_REQUIRED',
    obligation_id: 'work:one',
    run_id: 'run:one',
    claimed_revision: 'authority:before',
    assignment_sha256: 'b'.repeat(64),
    candidate_branch: 'overcenter/candidate/run:one',
    candidate_branch_base_sha: 'c'.repeat(40),
    dispatch: receipt.dispatch,
  });
});

test('project submit result excludes transport envelope metadata', () => {
  const receipt = {
    schema: 'overcenter-project-submit/v1',
    command: 'project.submit',
    transport: 'github-actions-job-rerun',
    repository_id: 42,
    repository_full_name: 'owner/repo',
    command_source_sha: 'a'.repeat(40),
    command_run_id: 100,
    command_run_attempt: 2,
    authority_ref: 'refs/overcenter/state',
    authority_head: 'authority:def',
    candidate_sha: 'e'.repeat(40),
    obligation_id: 'work:one',
    run_id: 'run:one',
    claimed_revision: 'authority:before',
    assignment_sha256: 'b'.repeat(64),
    output_sha256: 'f'.repeat(64),
    integration_commit: '1'.repeat(40),
    disposition: 'DONE' as const,
    verified: true,
    settlement_commit: 'authority:settled',
    already_settled: false,
    receipt_digest: 'd'.repeat(64),
  };

  assert.deepEqual(projectSubmitResult(receipt), {
    authority_head: 'authority:def',
    candidate_sha: 'e'.repeat(40),
    obligation_id: 'work:one',
    run_id: 'run:one',
    claimed_revision: 'authority:before',
    assignment_sha256: 'b'.repeat(64),
    output_sha256: 'f'.repeat(64),
    integration_commit: '1'.repeat(40),
    disposition: 'DONE',
    verified: true,
    settlement_commit: 'authority:settled',
    already_settled: false,
  });
});
