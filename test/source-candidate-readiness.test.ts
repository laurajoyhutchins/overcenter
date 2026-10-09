import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessCandidateReadiness,
  type CandidateReadinessSnapshot,
} from '../src/source/candidate-readiness.ts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

function snapshot(
  overrides: Partial<CandidateReadinessSnapshot> = {},
): CandidateReadinessSnapshot {
  return {
    repository: 'laurajoyhutchins/arcata',
    pull_number: 262,
    expected_head_sha: head,
    expected_base_sha: base,
    observed_head_sha: head,
    observed_base_sha: base,
    mergeability: 'clean',
    draft: false,
    protected_paths_modified: false,
    required_check_names: ['check / check', 'candidate evidence'],
    checks: [
      { name: 'check / check', head_sha: head, status: 'completed', conclusion: 'success' },
      { name: 'candidate evidence', head_sha: head, status: 'completed', conclusion: 'success' },
    ],
    ...overrides,
  };
}

test('a fully checked candidate can request, but never grant, source admission', () => {
  assert.deepEqual(assessCandidateReadiness(snapshot()), {
    decision: 'READY_TO_REQUEST_ADMISSION',
    reason: 'ALL_OBSERVED_CHECKS_PASSED_REQUIRE_EXTERNAL_ADMISSION',
    candidate_sha: head,
    base_sha: base,
    effect_authorized: false,
  });
});

test('source movement always requires new realization, even with green stale checks', () => {
  assert.equal(
    assessCandidateReadiness(snapshot({ observed_head_sha: 'c'.repeat(40) })).decision,
    'REREALIZE_HEAD',
  );
  assert.equal(
    assessCandidateReadiness(snapshot({ observed_base_sha: 'd'.repeat(40) })).decision,
    'REREALIZE_BASE',
  );
  assert.equal(
    assessCandidateReadiness(snapshot({ mergeability: 'behind' })).decision,
    'REREALIZE_BASE',
  );
});

test('merge conflicts, unknown mergeability and draft candidates fail closed', () => {
  assert.equal(
    assessCandidateReadiness(snapshot({ mergeability: 'dirty' })).decision,
    'REPAIR_CONFLICT',
  );
  for (const state of ['unknown', 'unstable'] as const) {
    assert.equal(
      assessCandidateReadiness(snapshot({ mergeability: state })).decision,
      'AWAIT_MERGEABILITY',
    );
  }
  assert.equal(
    assessCandidateReadiness(snapshot({ draft: true })).decision,
    'AWAIT_DRAFT_PROMOTION',
  );
});

test('required exact-head checks cannot be missing, stale, duplicated, or failing', () => {
  assert.equal(
    assessCandidateReadiness(snapshot({ checks: [] })).decision,
    'AWAIT_CHECKS',
  );
  assert.equal(
    assessCandidateReadiness(
      snapshot({
        checks: [
          { name: 'check / check', head_sha: head, status: 'completed', conclusion: 'success' },
          { name: 'check / check', head_sha: head, status: 'completed', conclusion: 'success' },
        ],
      }),
    ).decision,
    'REJECT_DUPLICATE_EVIDENCE',
  );
  assert.equal(
    assessCandidateReadiness(
      snapshot({
        checks: [
          { name: 'check / check', head_sha: base, status: 'completed', conclusion: 'success' },
        ],
      }),
    ).decision,
    'REJECT_CHECK_IDENTITY',
  );
  assert.equal(
    assessCandidateReadiness(
      snapshot({
        checks: [
          { name: 'check / check', head_sha: head, status: 'completed', conclusion: 'failure' },
        ],
      }),
    ).decision,
    'REJECT_CHECK_FAILURE',
  );
  assert.equal(
    assessCandidateReadiness(
      snapshot({
        checks: [
          { name: 'check / check', head_sha: head, status: 'in_progress', conclusion: null },
        ],
      }),
    ).decision,
    'AWAIT_CHECKS',
  );
});

test('protected changes never become executable integration authority', () => {
  const result = assessCandidateReadiness(snapshot({ protected_paths_modified: true }));
  assert.equal(result.decision, 'AWAIT_PROTECTED_SOURCE_REVIEW');
  assert.equal(result.effect_authorized, false);
});

test('invalid snapshots are rejected instead of being treated as missing checks', () => {
  const bad = [
    { repository: 'bad repo' },
    { pull_number: 0 },
    { expected_head_sha: 'short' },
    { expected_base_sha: 'c'.repeat(39) },
    { observed_head_sha: 'bogus' },
    { required_check_names: [] },
    { required_check_names: ['same', 'same'] },
    {
      checks: [
        { name: 'check / check', head_sha: 'broken', status: 'completed', conclusion: 'success' },
      ],
    },
  ] as const;
  for (const override of bad) {
    assert.equal(assessCandidateReadiness(snapshot(override)).decision, 'REJECT_INVALID');
  }
});

test('non-required checks cannot provide authority for a missing required context', () => {
  const result = assessCandidateReadiness(
    snapshot({
      checks: [{ name: 'other', head_sha: head, status: 'completed', conclusion: 'success' }],
    }),
  );
  assert.equal(result.decision, 'AWAIT_CHECKS');
  assert.equal(result.effect_authorized, false);
});
