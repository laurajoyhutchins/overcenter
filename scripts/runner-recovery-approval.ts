import { createHash } from 'node:crypto';

import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isPositiveSafeInteger,
} from '../src/validation.ts';

const REQUEST_SCHEMA = 'overcenter-runner-recovery-request/v1' as const;
const REVIEW_SCHEMA = 'overcenter-runner-recovery-review/v1' as const;
const SETTLEMENT_SCHEMA = 'overcenter-runner-recovery-settlement/v1' as const;
const OPERATION = 'gcp-runner-autoscaler-recovery/v1' as const;
const REPOSITORY = 'laurajoyhutchins/overcenter' as const;
const OWNER = 'laurajoyhutchins' as const;
const ENVIRONMENT = 'overcenter-owner-approval' as const;
const TARGET_REF = 'refs/heads/work/gcp-cloud-run-cloud-sql-bootstrap' as const;
const IDENTITY =
  'overcenter-deployer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com' as const;

const RESOURCE_SET = [
  'artifactregistry:us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner',
  'artifactregistry:us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner-control',
  'cloudbuild:projects/project-6b810532-a302-48dc-b56/locations/us-west1',
  'cloudrun:projects/project-6b810532-a302-48dc-b56/locations/us-west1/services/overcenter-github-runner-autoscaler',
  'cloudrun:projects/project-6b810532-a302-48dc-b56/locations/us-west1/services/overcenter-gcp-runner-launcher',
  'cloudrun-iam-policy:projects/project-6b810532-a302-48dc-b56/locations/us-west1/services/overcenter-gcp-runner-launcher:read',
  'secretmanager:projects/project-6b810532-a302-48dc-b56/secrets/overcenter-github-app-private-key:read',
] as const;

const PRIVILEGE_CEILING = [
  'artifactregistry.repositories.uploadArtifacts',
  'cloudbuild.builds.create',
  'cloudbuild.builds.get',
  'iam.serviceAccounts.actAs',
  'run.services.create',
  'run.services.get',
  'run.services.getIamPolicy',
  'run.services.update',
  'secretmanager.versions.access',
] as const;

const SIDE_EFFECTS = [
  'Submit Cloud Build jobs and write images to the existing Artifact Registry repository.',
  'Update the private runner launcher and autoscaler Cloud Run services.',
  'Read the existing GitHub App private-key secret and launcher IAM policy.',
] as const;

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^([1-9][0-9]*)\.([1-9][0-9]*)$/;

export interface EvidenceReference {
  uri: string;
  sha256: string;
}

export interface RunnerRecoveryManifestInput {
  repositoryFullName: string;
  acceptedBaseSha: string;
  targetRef: string;
  targetSha: string;
  targetTreeSha: string;
  workflowBlobSha: string;
  scriptBlobSha: string;
  evidenceRefs: EvidenceReference[];
  resources: string[];
  identityPrincipal: string;
  operationCapabilityCeiling: string[];
  effectiveIamGrantSnapshotSha256: string;
  runId: number;
  runAttempt: number;
  createdAt: string;
  expiresAt: string;
  requestedBy: string;
  reason: string;
  humanImpact: string;
  sideEffects: string[];
}

export interface RunnerRecoveryManifest {
  schema: typeof REQUEST_SCHEMA;
  request_id: string;
  operation: typeof OPERATION;
  repository_full_name: typeof REPOSITORY;
  accepted_base_sha: string;
  target_ref: typeof TARGET_REF;
  target_sha: string;
  target_tree_sha: string;
  workflow_blob_sha: string;
  script_blob_sha: string;
  evidence_refs: EvidenceReference[];
  resource_set: readonly string[];
  identity_principal: typeof IDENTITY;
  operation_capability_ceiling: readonly string[];
  effective_iam_grant_snapshot_sha256: string;
  created_at: string;
  expires_at: string;
  requested_by: typeof OWNER;
  reason: string;
  human_impact: string;
  declared_side_effects: readonly string[];
}

function fail(code: string): never {
  throw new Error(code);
}

function exactArray(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function sha40(value: unknown): value is string {
  return typeof value === 'string' && SHA40.test(value);
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function readManifestInput(value: unknown): RunnerRecoveryManifestInput {
  if (!isData(value)) fail('RUNNER_RECOVERY_MANIFEST_INPUT_INVALID');
  assertExactKeys(
    value,
    [
      'repositoryFullName',
      'acceptedBaseSha',
      'targetRef',
      'targetSha',
      'targetTreeSha',
      'workflowBlobSha',
      'scriptBlobSha',
      'evidenceRefs',
      'resources',
      'identityPrincipal',
      'operationCapabilityCeiling',
      'effectiveIamGrantSnapshotSha256',
      'runId',
      'runAttempt',
      'createdAt',
      'expiresAt',
      'requestedBy',
      'reason',
      'humanImpact',
      'sideEffects',
    ],
    [],
    'RUNNER_RECOVERY_MANIFEST_INPUT_INVALID',
  );

  for (const key of [
    'repositoryFullName',
    'acceptedBaseSha',
    'targetRef',
    'targetSha',
    'targetTreeSha',
    'workflowBlobSha',
    'scriptBlobSha',
    'createdAt',
    'expiresAt',
    'requestedBy',
    'reason',
    'humanImpact',
    'identityPrincipal',
  ]) {
    assertNonEmptyString(value[key], 'RUNNER_RECOVERY_MANIFEST_INPUT_INVALID');
  }

  if (
    typeof value.repositoryFullName !== 'string' ||
    typeof value.acceptedBaseSha !== 'string' ||
    typeof value.targetRef !== 'string' ||
    typeof value.targetSha !== 'string' ||
    typeof value.targetTreeSha !== 'string' ||
    typeof value.workflowBlobSha !== 'string' ||
    typeof value.scriptBlobSha !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.requestedBy !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.humanImpact !== 'string' ||
    typeof value.identityPrincipal !== 'string' ||
    !isPositiveSafeInteger(value.runId) ||
    !isPositiveSafeInteger(value.runAttempt) ||
    !Array.isArray(value.evidenceRefs) ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.operationCapabilityCeiling) ||
    typeof value.effectiveIamGrantSnapshotSha256 !== 'string' ||
    !Array.isArray(value.sideEffects)
  ) {
    fail('RUNNER_RECOVERY_MANIFEST_INPUT_INVALID');
  }

  return value as unknown as RunnerRecoveryManifestInput;
}

export function createRunnerRecoveryManifest(
  inputValue: RunnerRecoveryManifestInput,
): { manifest: RunnerRecoveryManifest; canonicalJson: string; sha256: string } {
  const input = readManifestInput(inputValue);
  if (input.repositoryFullName !== REPOSITORY) fail('RUNNER_RECOVERY_REPOSITORY_MISMATCH');
  if (!sha40(input.acceptedBaseSha) || !sha40(input.targetSha)) {
    fail('RUNNER_RECOVERY_REVISION_INVALID');
  }
  if (!sha40(input.targetTreeSha) || !sha40(input.workflowBlobSha) || !sha40(input.scriptBlobSha)) {
    fail('RUNNER_RECOVERY_REVISION_INVALID');
  }
  if (input.targetRef !== TARGET_REF) fail('RUNNER_RECOVERY_TARGET_REF_INVALID');

  if (input.runAttempt !== 1) fail('RUNNER_RECOVERY_RUN_ATTEMPT_INVALID');
  const requestId = String(input.runId) + '.' + String(input.runAttempt);

  if (!isoTimestamp(input.createdAt) || !isoTimestamp(input.expiresAt)) {
    fail('RUNNER_RECOVERY_EXPIRY_INVALID');
  }
  if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) {
    fail('RUNNER_RECOVERY_EXPIRY_INVALID');
  }
  if (
    input.requestedBy !== OWNER ||
    input.reason.trim().length === 0 ||
    input.reason.length > 500 ||
    /[\r\n]/.test(input.reason)
  ) {
    fail('RUNNER_RECOVERY_REQUEST_AUTHORIZATION_INVALID');
  }
  if (input.humanImpact.trim().length === 0 || input.humanImpact.length > 1000) {
    fail('RUNNER_RECOVERY_IMPACT_INVALID');
  }
  if (input.identityPrincipal !== IDENTITY) fail('RUNNER_RECOVERY_IDENTITY_MISMATCH');
  if (!exactArray(input.resources, RESOURCE_SET)) {
    fail('RUNNER_RECOVERY_RESOURCE_SCOPE_MISMATCH');
  }
  if (!exactArray(input.operationCapabilityCeiling, PRIVILEGE_CEILING)) {
    fail('RUNNER_RECOVERY_PRIVILEGE_CEILING_MISMATCH');
  }
  if (!SHA256.test(input.effectiveIamGrantSnapshotSha256)) {
    fail('RUNNER_RECOVERY_IAM_SNAPSHOT_INVALID');
  }
  if (!exactArray(input.sideEffects, SIDE_EFFECTS)) {
    fail('RUNNER_RECOVERY_SIDE_EFFECT_SET_MISMATCH');
  }
  if (input.evidenceRefs.length === 0) fail('RUNNER_RECOVERY_EVIDENCE_REQUIRED');

  const evidenceRefs = input.evidenceRefs.map((reference) => {
    if (!isData(reference)) fail('RUNNER_RECOVERY_EVIDENCE_INVALID');
    assertExactKeys(reference, ['uri', 'sha256'], [], 'RUNNER_RECOVERY_EVIDENCE_INVALID');
    if (
      typeof reference.uri !== 'string' ||
      !/^https:\/\/github\.com\/laurajoyhutchins\/overcenter\//.test(reference.uri) ||
      typeof reference.sha256 !== 'string' ||
      !SHA256.test(reference.sha256)
    ) {
      fail('RUNNER_RECOVERY_EVIDENCE_INVALID');
    }
    return { uri: reference.uri, sha256: reference.sha256 };
  });
  const sortedEvidence = [...evidenceRefs].sort((left, right) => left.uri.localeCompare(right.uri));
  if (
    sortedEvidence.some((reference, index) => reference.uri !== evidenceRefs[index]?.uri) ||
    new Set(evidenceRefs.map((reference) => reference.uri)).size !== evidenceRefs.length
  ) {
    fail('RUNNER_RECOVERY_EVIDENCE_NONCANONICAL');
  }

  const manifest: RunnerRecoveryManifest = {
    schema: REQUEST_SCHEMA,
    request_id: requestId,
    operation: OPERATION,
    repository_full_name: REPOSITORY,
    accepted_base_sha: input.acceptedBaseSha,
    target_ref: TARGET_REF,
    target_sha: input.targetSha,
    target_tree_sha: input.targetTreeSha,
    workflow_blob_sha: input.workflowBlobSha,
    script_blob_sha: input.scriptBlobSha,
    evidence_refs: evidenceRefs,
    resource_set: RESOURCE_SET,
    identity_principal: IDENTITY,
    operation_capability_ceiling: PRIVILEGE_CEILING,
    effective_iam_grant_snapshot_sha256: input.effectiveIamGrantSnapshotSha256,
    created_at: input.createdAt,
    expires_at: input.expiresAt,
    requested_by: OWNER,
    reason: input.reason,
    human_impact: input.humanImpact,
    declared_side_effects: SIDE_EFFECTS,
  };
  const canonicalJson = JSON.stringify(manifest, null, 2) + '\n';
  const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
  return { manifest, canonicalJson, sha256 };
}

export type ApprovalGateResult = 'success' | 'failure' | 'cancelled' | 'skipped' | 'unknown';

export interface EnvironmentApproval {
  state?: unknown;
  comment?: unknown;
  user?: { login?: unknown };
  environments?: Array<{ name?: unknown }>;
}

export interface RunnerRecoveryReviewInput {
  evidenceAvailable: boolean;
  approvals: EnvironmentApproval[];
  expectedEnvironment: string;
  expectedReviewer: string;
  gateJobResult: ApprovalGateResult;
  runId: number;
  requestId: string;
  runAttempt: number;
  expiresAt: string;
  now: string;
}

export type RunnerRecoveryReviewState =
  | 'approved'
  | 'rejected'
  | 'unreviewed'
  | 'unauthorized'
  | 'unavailable'
  | 'expired'
  | 'replay_blocked';

export interface RunnerRecoveryReviewReceipt {
  schema: typeof REVIEW_SCHEMA;
  request_id: string;
  review_state: RunnerRecoveryReviewState;
  reviewed_by: string | null;
  review_comment: string | null;
  outcome: string;
}

function reviewReceipt(
  input: RunnerRecoveryReviewInput,
  state: RunnerRecoveryReviewState,
  reviewer: string | null,
  comment: string | null,
  outcome: string,
): RunnerRecoveryReviewReceipt {
  return {
    schema: REVIEW_SCHEMA,
    request_id: input.requestId,
    review_state: state,
    reviewed_by: reviewer,
    review_comment: comment,
    outcome,
  };
}

export function classifyRunnerRecoveryApproval(
  input: RunnerRecoveryReviewInput,
): RunnerRecoveryReviewReceipt {
  if (input.expectedEnvironment !== ENVIRONMENT || input.expectedReviewer !== OWNER) {
    return reviewReceipt(input, 'unauthorized', null, null, 'review_policy_mismatch');
  }
  if (!isPositiveSafeInteger(input.runId) || !isPositiveSafeInteger(input.runAttempt)) {
    return reviewReceipt(input, 'replay_blocked', null, null, 'request_replay_blocked');
  }
  const requestIdMatch = REQUEST_ID.exec(input.requestId);
  if (
    !requestIdMatch ||
    Number(requestIdMatch[1]) !== input.runId ||
    Number(requestIdMatch[2]) !== input.runAttempt ||
    input.runAttempt !== 1
  ) {
    return reviewReceipt(input, 'replay_blocked', null, null, 'request_replay_blocked');
  }
  if (!input.evidenceAvailable) {
    return reviewReceipt(input, 'unavailable', null, null, 'approval_evidence_unavailable');
  }

  const matching = input.approvals.filter((record) =>
    record.environments?.some((environment) => environment.name === input.expectedEnvironment),
  );
  const latest = matching.at(-1);
  const state = latest?.state;
  const reviewer = typeof latest?.user?.login === 'string' ? latest.user.login : null;
  const comment = typeof latest?.comment === 'string' ? latest.comment : null;
  if (state !== 'approved' && state !== 'rejected') {
    const outcome =
      input.gateJobResult === 'cancelled'
        ? 'cancelled_without_review'
        : input.gateJobResult === 'failure'
          ? 'approval_not_settled'
          : 'approval_not_recorded';
    return reviewReceipt(input, 'unreviewed', null, null, outcome);
  }
  if (reviewer !== input.expectedReviewer) {
    return reviewReceipt(input, 'unauthorized', reviewer, comment, 'reviewer_not_authorized');
  }
  if (state === 'rejected') {
    return reviewReceipt(input, 'rejected', reviewer, comment, 'rejected');
  }
  if (!isoTimestamp(input.expiresAt) || !isoTimestamp(input.now)) {
    return reviewReceipt(input, 'expired', reviewer, comment, 'request_expiry_invalid');
  }
  if (Date.parse(input.now) >= Date.parse(input.expiresAt)) {
    return reviewReceipt(input, 'expired', reviewer, comment, 'request_expired');
  }
  if (input.gateJobResult !== 'success') {
    return reviewReceipt(input, 'approved', reviewer, comment, 'approval_gate_did_not_succeed');
  }
  return reviewReceipt(input, 'approved', reviewer, comment, 'approved');
}

export type OperationResult = 'success' | 'failure' | 'cancelled' | 'not_started' | 'unknown';
export type ReadbackResult = 'target_verified' | 'not_applied' | 'mismatch' | 'unavailable' | 'not_attempted';

export interface RunnerRecoverySettlementInput {
  review: RunnerRecoveryReviewReceipt;
  requestId: string;
  runId: number;
  runAttempt: number;
  manifestSha256: string;
  targetSha: string;
  targetTreeSha: string;
  operationResult: OperationResult;
  readbackResult: ReadbackResult;
}

export interface RunnerRecoverySettlementReceipt {
  schema: typeof SETTLEMENT_SCHEMA;
  request_id: string;
  run_id: number;
  run_attempt: number;
  manifest_sha256: string;
  target_sha: string;
  target_tree_sha: string;
  binding_valid: boolean;
  review_state: RunnerRecoveryReviewState;
  reviewed_by: string | null;
  review_comment: string | null;
  operation_result: OperationResult;
  readback_result: ReadbackResult;
  outcome: 'settled' | 'rejected' | 'not_authorized' | 'not_started' | 'failed' | 'indeterminate';
}

export function settleRunnerRecovery(
  input: RunnerRecoverySettlementInput,
): RunnerRecoverySettlementReceipt {
  const bindingValid =
    isPositiveSafeInteger(input.runId) &&
    input.runAttempt === 1 &&
    input.requestId === String(input.runId) + '.' + String(input.runAttempt) &&
    input.review.schema === REVIEW_SCHEMA &&
    input.review.request_id === input.requestId &&
    sha40(input.targetSha) &&
    sha40(input.targetTreeSha) &&
    SHA256.test(input.manifestSha256);

  const ownerApproved =
    input.review.review_state === 'approved' &&
    input.review.outcome === 'approved' &&
    input.review.reviewed_by === OWNER;

  let outcome: RunnerRecoverySettlementReceipt['outcome'];
  if (!bindingValid) {
    outcome = 'indeterminate';
  } else if (
    input.review.review_state === 'rejected' &&
    input.review.outcome === 'rejected' &&
    input.operationResult === 'not_started' &&
    input.readbackResult === 'not_attempted'
  ) {
    outcome = 'rejected';
  } else if (!ownerApproved) {
    outcome =
      input.operationResult === 'not_started' && input.readbackResult === 'not_attempted'
        ? 'not_authorized'
        : 'indeterminate';
  } else if (input.operationResult === 'not_started' && input.readbackResult === 'not_attempted') {
    outcome = 'not_started';
  } else if (input.operationResult === 'success' && input.readbackResult === 'target_verified') {
    outcome = 'settled';
  } else if (input.operationResult === 'failure' && input.readbackResult === 'not_applied') {
    outcome = 'failed';
  } else {
    outcome = 'indeterminate';
  }

  return {
    schema: SETTLEMENT_SCHEMA,
    request_id: input.requestId,
    run_id: input.runId,
    run_attempt: input.runAttempt,
    manifest_sha256: input.manifestSha256,
    target_sha: input.targetSha,
    target_tree_sha: input.targetTreeSha,
    binding_valid: bindingValid,
    review_state: input.review.review_state,
    reviewed_by: input.review.reviewed_by,
    review_comment: input.review.review_comment,
    operation_result: input.operationResult,
    readback_result: input.readbackResult,
    outcome,
  };
}
