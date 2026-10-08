import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const moduleUrl = '../scripts/runner-recovery-approval.ts';

async function implementation() {
  const module = await import(moduleUrl).catch(() => null);
  assert.ok(module, 'runner recovery approval module should be available');
  return module;
}

const resourceSet = [
  'artifactregistry:us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner',
  'artifactregistry:us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner-control',
  'cloudbuild:projects/project-6b810532-a302-48dc-b56/locations/us-west1',
  'cloudrun:projects/project-6b810532-a302-48dc-b56/locations/us-west1/services/overcenter-github-runner-autoscaler',
  'cloudrun:projects/project-6b810532-a302-48dc-b56/locations/us-west1/services/overcenter-gcp-runner-launcher',
  'cloudrun-iam-policy:projects/project-6b810532-a302-48dc-b56/locations/us-west1/services/overcenter-gcp-runner-launcher:read',
  'secretmanager:projects/project-6b810532-a302-48dc-b56/secrets/overcenter-github-app-private-key:read',
];

const operationCapabilityCeiling = [
  'artifactregistry.repositories.uploadArtifacts',
  'cloudbuild.builds.create',
  'cloudbuild.builds.get',
  'iam.serviceAccounts.actAs',
  'run.services.create',
  'run.services.get',
  'run.services.getIamPolicy',
  'run.services.update',
  'secretmanager.versions.access',
];

const input = {
  repositoryFullName: 'laurajoyhutchins/overcenter',
  acceptedBaseSha: 'a'.repeat(40),
  targetRef: 'refs/heads/work/gcp-cloud-run-cloud-sql-bootstrap',
  targetSha: 'b'.repeat(40),
  targetTreeSha: 'c'.repeat(40),
  workflowBlobSha: 'd'.repeat(40),
  scriptBlobSha: 'e'.repeat(40),
  evidenceRefs: [
    {
      uri: 'https://github.com/laurajoyhutchins/overcenter/actions/runs/37750000000',
      sha256: 'f'.repeat(64),
    },
  ],
  resources: resourceSet,
  identityPrincipal: 'overcenter-deployer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
  operationCapabilityCeiling,
  effectiveIamGrantSnapshotSha256: '1'.repeat(64),
  runId: 37750000000,
  runAttempt: 1,
  createdAt: '2026-10-08T07:00:00.000Z',
  expiresAt: '2026-10-08T07:30:00.000Z',
  requestedBy: 'laurajoyhutchins',
  reason: 'Recover the runner control plane after a queued recovery job.',
  humanImpact: 'May build runner images and update two private Cloud Run services.',
  sideEffects: [
    'Submit Cloud Build jobs and write images to the existing Artifact Registry repository.',
    'Update the private runner launcher and autoscaler Cloud Run services.',
    'Read the existing GitHub App private-key secret and launcher IAM policy.',
  ],
};

function approval(state: string, login = 'laurajoyhutchins') {
  return {
    state,
    comment: 'Reviewed exact request',
    user: { login },
    environments: [{ name: 'overcenter-owner-approval' }],
  };
}

test('builds a canonical immutable manifest for the fixed recovery scope', async () => {
  const { createRunnerRecoveryManifest } = await implementation();
  const result = createRunnerRecoveryManifest(input);
  const expected = {
    schema: 'overcenter-runner-recovery-request/v1',
    request_id: '37750000000.1',
    operation: 'gcp-runner-autoscaler-recovery/v1',
    repository_full_name: 'laurajoyhutchins/overcenter',
    accepted_base_sha: 'a'.repeat(40),
    target_ref: 'refs/heads/work/gcp-cloud-run-cloud-sql-bootstrap',
    target_sha: 'b'.repeat(40),
    target_tree_sha: 'c'.repeat(40),
    workflow_blob_sha: 'd'.repeat(40),
    script_blob_sha: 'e'.repeat(40),
    evidence_refs: [
      {
        uri: 'https://github.com/laurajoyhutchins/overcenter/actions/runs/37750000000',
        sha256: 'f'.repeat(64),
      },
    ],
    resource_set: resourceSet,
    identity_principal:
      'overcenter-deployer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com',
    operation_capability_ceiling: operationCapabilityCeiling,
    effective_iam_grant_snapshot_sha256: '1'.repeat(64),
    created_at: '2026-10-08T07:00:00.000Z',
    expires_at: '2026-10-08T07:30:00.000Z',
    requested_by: 'laurajoyhutchins',
    reason: 'Recover the runner control plane after a queued recovery job.',
    human_impact: 'May build runner images and update two private Cloud Run services.',
    declared_side_effects: [
      'Submit Cloud Build jobs and write images to the existing Artifact Registry repository.',
      'Update the private runner launcher and autoscaler Cloud Run services.',
      'Read the existing GitHub App private-key secret and launcher IAM policy.',
    ],
  };
  const canonicalJson = JSON.stringify(expected, null, 2) + '\n';
  assert.deepEqual(result.manifest, expected);
  assert.equal(result.canonicalJson, canonicalJson);
  assert.equal(result.sha256, createHash('sha256').update(canonicalJson).digest('hex'));
});

test('rejects a manifest whose target is not the selected infrastructure branch', async () => {
  const { createRunnerRecoveryManifest } = await implementation();
  assert.throws(
    () => createRunnerRecoveryManifest({ ...input, targetRef: 'refs/heads/main' }),
    /RUNNER_RECOVERY_TARGET_REF_INVALID/,
  );
});

test('rejects a broadened GCP resource set or identity ceiling', async () => {
  const { createRunnerRecoveryManifest } = await implementation();
  assert.throws(
    () => createRunnerRecoveryManifest({ ...input, resources: [...resourceSet, 'cloudrun:*'] }),
    /RUNNER_RECOVERY_RESOURCE_SCOPE_MISMATCH/,
  );
  assert.throws(
    () => createRunnerRecoveryManifest({
      ...input,
      operationCapabilityCeiling: [...operationCapabilityCeiling, 'resourcemanager.projects.setIamPolicy'],
    }),
    /RUNNER_RECOVERY_PRIVILEGE_CEILING_MISMATCH/,
  );
  assert.throws(
    () => createRunnerRecoveryManifest({
      ...input,
      identityPrincipal: 'overcenter-admin@project.iam.gserviceaccount.com',
    }),
    /RUNNER_RECOVERY_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () => createRunnerRecoveryManifest({ ...input, effectiveIamGrantSnapshotSha256: 'not-a-sha256' }),
    /RUNNER_RECOVERY_IAM_SNAPSHOT_INVALID/,
  );
});

test('rejects malformed or expired request envelopes', async () => {
  const { createRunnerRecoveryManifest } = await implementation();
  assert.throws(
    () => createRunnerRecoveryManifest({ ...input, targetSha: 'not-a-sha' }),
    /RUNNER_RECOVERY_REVISION_INVALID/,
  );
  assert.throws(
    () => createRunnerRecoveryManifest({ ...input, runAttempt: 2 }),
    /RUNNER_RECOVERY_RUN_ATTEMPT_INVALID/,
  );
  assert.throws(
    () => createRunnerRecoveryManifest({
      ...input,
      createdAt: '2026-10-08T07:30:00.000Z',
      expiresAt: '2026-10-08T07:00:00.000Z',
    }),
    /RUNNER_RECOVERY_EXPIRY_INVALID/,
  );
});

test('records an owner approval only when the gate, reviewer, attempt, and expiry all match', async () => {
  const { classifyRunnerRecoveryApproval } = await implementation();
  const result = classifyRunnerRecoveryApproval({
    evidenceAvailable: true,
    approvals: [approval('approved')],
    expectedEnvironment: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
    gateJobResult: 'success',
    runId: 37750000000,
    requestId: '37750000000.1',
    runAttempt: 1,
    expiresAt: '2026-10-08T07:30:00.000Z',
    now: '2026-10-08T07:10:00.000Z',
  });
  assert.deepEqual(result, {
    schema: 'overcenter-runner-recovery-review/v1',
    request_id: '37750000000.1',
    review_state: 'approved',
    reviewed_by: 'laurajoyhutchins',
    review_comment: 'Reviewed exact request',
    outcome: 'approved',
  });
});

test('blocks a review record bound to another GitHub run id', async () => {
  const { classifyRunnerRecoveryApproval } = await implementation();
  const result = classifyRunnerRecoveryApproval({
    evidenceAvailable: true,
    approvals: [approval('approved')],
    expectedEnvironment: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
    gateJobResult: 'success',
    runId: 37750000001,
    requestId: '37750000000.1',
    runAttempt: 1,
    expiresAt: '2026-10-08T07:30:00.000Z',
    now: '2026-10-08T07:10:00.000Z',
  });
  assert.equal(result.review_state, 'replay_blocked');
  assert.equal(result.outcome, 'request_replay_blocked');
});

test('preserves owner rejection and fails closed on unauthorized or unavailable evidence', async () => {
  const { classifyRunnerRecoveryApproval } = await implementation();
  const rejected = classifyRunnerRecoveryApproval({
    evidenceAvailable: true,
    approvals: [approval('rejected')],
    expectedEnvironment: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
    gateJobResult: 'failure',
    runId: 37750000000,
    requestId: '37750000000.1',
    runAttempt: 1,
    expiresAt: '2026-10-08T07:30:00.000Z',
    now: '2026-10-08T07:10:00.000Z',
  });
  assert.equal(rejected.review_state, 'rejected');
  assert.equal(rejected.reviewed_by, 'laurajoyhutchins');
  assert.equal(rejected.outcome, 'rejected');

  const unauthorized = classifyRunnerRecoveryApproval({
    evidenceAvailable: true,
    approvals: [approval('approved', 'other-user')],
    expectedEnvironment: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
    gateJobResult: 'success',
    runId: 37750000000,
    requestId: '37750000000.1',
    runAttempt: 1,
    expiresAt: '2026-10-08T07:30:00.000Z',
    now: '2026-10-08T07:10:00.000Z',
  });
  assert.equal(unauthorized.review_state, 'unauthorized');
  assert.equal(unauthorized.outcome, 'reviewer_not_authorized');

  const unavailable = classifyRunnerRecoveryApproval({
    evidenceAvailable: false,
    approvals: [],
    expectedEnvironment: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
    gateJobResult: 'success',
    runId: 37750000000,
    requestId: '37750000000.1',
    runAttempt: 1,
    expiresAt: '2026-10-08T07:30:00.000Z',
    now: '2026-10-08T07:10:00.000Z',
  });
  assert.equal(unavailable.review_state, 'unavailable');
  assert.equal(unavailable.outcome, 'approval_evidence_unavailable');
});

test('blocks expired approvals and attempts after the original run', async () => {
  const { classifyRunnerRecoveryApproval } = await implementation();
  const expired = classifyRunnerRecoveryApproval({
    evidenceAvailable: true,
    approvals: [approval('approved')],
    expectedEnvironment: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
    gateJobResult: 'success',
    runId: 37750000000,
    requestId: '37750000000.1',
    runAttempt: 1,
    expiresAt: '2026-10-08T07:30:00.000Z',
    now: '2026-10-08T07:30:00.001Z',
  });
  assert.equal(expired.review_state, 'expired');
  assert.equal(expired.outcome, 'request_expired');

  const replayed = classifyRunnerRecoveryApproval({
    evidenceAvailable: true,
    approvals: [approval('approved')],
    expectedEnvironment: 'overcenter-owner-approval',
    expectedReviewer: 'laurajoyhutchins',
    gateJobResult: 'success',
    runId: 37750000000,
    requestId: '37750000000.1',
    runAttempt: 2,
    expiresAt: '2026-10-08T07:30:00.000Z',
    now: '2026-10-08T07:10:00.000Z',
  });
  assert.equal(replayed.review_state, 'replay_blocked');
  assert.equal(replayed.outcome, 'request_replay_blocked');
});

test('settles only on successful independent readback and preserves uncertain outcomes', async () => {
  const { settleRunnerRecovery } = await implementation();
  const settled = settleRunnerRecovery({
    review: {
      schema: 'overcenter-runner-recovery-review/v1',
      request_id: '37750000000.1',
      review_state: 'approved',
      reviewed_by: 'laurajoyhutchins',
      review_comment: 'Reviewed exact request',
      outcome: 'approved',
    },
    requestId: '37750000000.1',
    runId: 37750000000,
    runAttempt: 1,
    manifestSha256: 'f'.repeat(64),
    targetSha: 'b'.repeat(40),
    targetTreeSha: 'c'.repeat(40),
    operationResult: 'success',
    readbackResult: 'target_verified',
  });
  assert.equal(settled.outcome, 'settled');
  assert.equal(settled.reviewed_by, 'laurajoyhutchins');
  assert.equal(settled.binding_valid, true);
  assert.equal(settled.manifest_sha256, 'f'.repeat(64));
  assert.equal(settled.target_sha, 'b'.repeat(40));
  assert.equal(settled.target_tree_sha, 'c'.repeat(40));

  const mismatchedRun = settleRunnerRecovery({
    review: {
      schema: 'overcenter-runner-recovery-review/v1',
      request_id: '37750000000.1',
      review_state: 'approved',
      reviewed_by: 'laurajoyhutchins',
      review_comment: 'Reviewed exact request',
      outcome: 'approved',
    },
    requestId: '37750000001.1',
    runId: 37750000000,
    runAttempt: 1,
    manifestSha256: 'f'.repeat(64),
    targetSha: 'b'.repeat(40),
    targetTreeSha: 'c'.repeat(40),
    operationResult: 'success',
    readbackResult: 'target_verified',
  });
  assert.equal(mismatchedRun.outcome, 'indeterminate');
  assert.equal(mismatchedRun.binding_valid, false);

  const uncertain = settleRunnerRecovery({
    review: {
      schema: 'overcenter-runner-recovery-review/v1',
      request_id: '37750000000.1',
      review_state: 'approved',
      reviewed_by: 'laurajoyhutchins',
      review_comment: 'Reviewed exact request',
      outcome: 'approved',
    },
    requestId: '37750000000.1',
    runId: 37750000000,
    runAttempt: 1,
    manifestSha256: 'f'.repeat(64),
    targetSha: 'b'.repeat(40),
    targetTreeSha: 'c'.repeat(40),
    operationResult: 'failure',
    readbackResult: 'unavailable',
  });
  assert.equal(uncertain.outcome, 'indeterminate');
  assert.equal(uncertain.reviewed_by, 'laurajoyhutchins');

  const rejected = settleRunnerRecovery({
    review: {
      schema: 'overcenter-runner-recovery-review/v1',
      request_id: '37750000000.1',
      review_state: 'rejected',
      reviewed_by: 'laurajoyhutchins',
      review_comment: 'No.',
      outcome: 'rejected',
    },
    requestId: '37750000000.1',
    runId: 37750000000,
    runAttempt: 1,
    manifestSha256: 'f'.repeat(64),
    targetSha: 'b'.repeat(40),
    targetTreeSha: 'c'.repeat(40),
    operationResult: 'not_started',
    readbackResult: 'not_attempted',
  });
  assert.equal(rejected.outcome, 'rejected');
});
