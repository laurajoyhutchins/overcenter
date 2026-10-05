import { execFileSync } from 'node:child_process';

import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';
import { assertSupportedSourceDelta, observeRepositoryDelta } from './repository-delta.ts';
import {
  SOURCE_CANDIDATE_SCHEMA,
  validateSourceCandidate,
  validateSourceTaskPacket,
  type SourceCandidate,
  type SourceClaimBinding,
  type SourceTaskPacket,
} from './source-obligation.ts';

export const SOURCE_VERIFICATION_SCHEMA = 'overcenter-source-verification/v1' as const;
export const SOURCE_INTEGRATION_EVIDENCE_SCHEMA =
  'overcenter-source-integration-evidence/v1' as const;

export type SourceCandidatePublicationResult =
  | { state: 'PUBLISHED' | 'ALREADY_PUBLISHED'; ref: string; candidate_sha: string }
  | { state: 'CONFLICT'; ref: string; observed_sha: string };

export interface SourceVerification {
  schema: typeof SOURCE_VERIFICATION_SCHEMA;
  state: 'verified' | 'rejected';
  run_id: string;
  candidate_sha: string;
  base_sha: string;
  tree_sha: string | null;
  reason: string | null;
}

export interface SourceIntegrationEvidence {
  schema: typeof SOURCE_INTEGRATION_EVIDENCE_SCHEMA;
  run_id: string;
  obligation_key: string;
  source_sha: string;
  candidate_sha: string;
  verification_base_sha: string;
  verified_tree_sha: string;
  integration_commit: string;
  state: 'integrated' | 'already-integrated';
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function exactSha(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(error);
}

function sourceControlPath(path: string): boolean {
  return (
    path === '.overcenter' ||
    path.startsWith('.overcenter/') ||
    path === '.github' ||
    path.startsWith('.github/')
  );
}

export function validateSourceVerification(value: unknown): SourceVerification {
  if (!isData(value)) throw new Error('SOURCE_VERIFICATION_INVALID');
  assertExactKeys(
    value,
    ['schema', 'state', 'run_id', 'candidate_sha', 'base_sha', 'tree_sha', 'reason'],
    [],
    'SOURCE_VERIFICATION_INVALID',
  );
  if (value.schema !== SOURCE_VERIFICATION_SCHEMA) {
    throw new Error('SOURCE_VERIFICATION_SCHEMA_MISMATCH');
  }
  if (value.state !== 'verified' && value.state !== 'rejected') {
    throw new Error('SOURCE_VERIFICATION_STATE_INVALID');
  }
  assertNonEmptyString(value.run_id, 'SOURCE_VERIFICATION_RUN_ID_INVALID');
  exactSha(value.candidate_sha, 'SOURCE_VERIFICATION_CANDIDATE_SHA_INVALID');
  exactSha(value.base_sha, 'SOURCE_VERIFICATION_BASE_SHA_INVALID');
  if (value.state === 'verified') {
    exactSha(value.tree_sha, 'SOURCE_VERIFICATION_TREE_SHA_INVALID');
    if (value.reason !== null) throw new Error('SOURCE_VERIFICATION_REASON_INVALID');
  } else {
    if (value.tree_sha !== null) throw new Error('SOURCE_VERIFICATION_TREE_INVALID');
    assertNonEmptyString(value.reason, 'SOURCE_VERIFICATION_REASON_INVALID');
  }
  return {
    schema: SOURCE_VERIFICATION_SCHEMA,
    state: value.state,
    run_id: value.run_id,
    candidate_sha: value.candidate_sha,
    base_sha: value.base_sha,
    tree_sha: value.tree_sha,
    reason: value.reason,
  };
}

export function validateSourceIntegrationEvidence(value: unknown): SourceIntegrationEvidence {
  if (!isData(value)) throw new Error('SOURCE_INTEGRATION_EVIDENCE_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'run_id',
      'obligation_key',
      'source_sha',
      'candidate_sha',
      'verification_base_sha',
      'verified_tree_sha',
      'integration_commit',
      'state',
    ],
    [],
    'SOURCE_INTEGRATION_EVIDENCE_INVALID',
  );
  if (value.schema !== SOURCE_INTEGRATION_EVIDENCE_SCHEMA) {
    throw new Error('SOURCE_INTEGRATION_EVIDENCE_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.run_id, 'SOURCE_INTEGRATION_EVIDENCE_RUN_INVALID');
  assertNonEmptyString(value.obligation_key, 'SOURCE_INTEGRATION_EVIDENCE_KEY_INVALID');
  exactSha(value.source_sha, 'SOURCE_INTEGRATION_EVIDENCE_SOURCE_INVALID');
  exactSha(value.candidate_sha, 'SOURCE_INTEGRATION_EVIDENCE_CANDIDATE_INVALID');
  exactSha(value.verification_base_sha, 'SOURCE_INTEGRATION_EVIDENCE_BASE_INVALID');
  exactSha(value.verified_tree_sha, 'SOURCE_INTEGRATION_EVIDENCE_TREE_INVALID');
  exactSha(value.integration_commit, 'SOURCE_INTEGRATION_EVIDENCE_COMMIT_INVALID');
  if (value.state !== 'integrated' && value.state !== 'already-integrated') {
    throw new Error('SOURCE_INTEGRATION_EVIDENCE_STATE_INVALID');
  }
  return structuredClone(value) as unknown as SourceIntegrationEvidence;
}

export function integrateVerifiedSourceCandidate(
  _repo: string,
  _taskValue: unknown,
  _claim: SourceClaimBinding,
  _obligationId: string,
  _candidateSha: string,
  _verificationValue: unknown,
  _options: {
    remote?: string;
    ref?: string;
    performReservedMutation: (mutation: () => boolean) => boolean;
  },
): { state: 'REJECTED'; reason: 'SOURCE_DIRECT_MAIN_INTEGRATION_RETIRED' } {
  return { state: 'REJECTED', reason: 'SOURCE_DIRECT_MAIN_INTEGRATION_RETIRED' };
}

export function inspectSourceCandidate(
  repo: string,
  taskValue: unknown,
  claim: SourceClaimBinding,
  candidateSha: string,
  expectedObligationId?: string,
): { task: SourceTaskPacket; candidate: SourceCandidate; changed_paths: string[] } {
  const task = validateSourceTaskPacket(taskValue);
  exactSha(candidateSha, 'SOURCE_CANDIDATE_COMMIT_SHA_INVALID');

  const parents = git(repo, ['rev-list', '--parents', '-n', '1', candidateSha])
    .split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 2 || parents[1] !== claim.source_sha) {
    throw new Error('SOURCE_CANDIDATE_PARENT_MISMATCH');
  }

  if (expectedObligationId !== undefined) {
    assertNonEmptyString(expectedObligationId, 'SOURCE_CANDIDATE_OBLIGATION_INVALID');
    const body = git(repo, ['show', '-s', '--format=%B', candidateSha]);
    if (!body.split('\n').includes(`Overcenter-Obligation-Id: ${expectedObligationId}`)) {
      throw new Error('SOURCE_CANDIDATE_OBLIGATION_MISMATCH');
    }
  }

  const candidate = validateSourceCandidate(
    {
      schema: SOURCE_CANDIDATE_SCHEMA,
      obligation_key: claim.obligation_key,
      run_id: claim.run_id,
      claimed_revision: claim.claimed_revision,
      claimed_source_sha: claim.source_sha,
      commit_sha: candidateSha,
    },
    claim,
  );

  const delta = observeRepositoryDelta(repo, claim.source_sha, candidateSha);
  assertSupportedSourceDelta(delta);
  const changedPaths = delta.entries.map((entry) => entry.path);
  if (changedPaths.length === 0) throw new Error('SOURCE_CANDIDATE_EMPTY');
  if (changedPaths.some(sourceControlPath)) {
    throw new Error('SOURCE_CONTROL_PLANE_MUTATION_FORBIDDEN');
  }
  if (changedPaths.some((path) => !task.writable_paths.includes(path))) {
    throw new Error('SOURCE_SCOPE_VIOLATION');
  }

  return { task, candidate, changed_paths: changedPaths };
}
