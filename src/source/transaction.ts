import { execFileSync } from 'node:child_process';
import { canonicalDigest, canonicalJson } from '../digest.ts';
import { evidenceRef, type EvidenceRef } from '../evidence/reference.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isPositiveSafeInteger,
  isSha256Hex,
} from '../validation.ts';
import {
  assertSupportedSourceDelta,
  observeRepositoryDelta,
  repositoryDeltaChangedBytes,
} from './repository-delta.ts';
import {
  baselineSourceTransactionPlan,
  validateSourceTransactionContext,
  type SourceTransactionContext,
} from './transaction-baseline.ts';
import {
  authorizedSourceWriteScope,
  sourceWriteScopeAllowsPath,
  validateSourceTaskPacket,
  bindSourceClaim,
  type AuthorizedSourceWriteScope,
  type SourceClaimBinding,
} from './source-obligation.ts';
import {
  readSourceVerificationProfile,
  sourceVerificationProfileBinding,
  validateSourceVerificationProfile,
  type SourceVerificationProfile,
} from './source-verification-profile.ts';
import type { TransactionAssurancePlan } from './transaction-planner.ts';

export interface SourceTransactionPlan {
  schema: 'overcenter-source-transaction';
  schema_version: 3;
  repository_id: number;
  repository_full_name: string;
  runtime_sha: string;
  claim: SourceClaimBinding;
  candidate_sha: string;
  candidate_tree: string;
  verification_profile: { profile: SourceVerificationProfile; sha256: string };
  authorized_write_scope: AuthorizedSourceWriteScope;
  expected_write_set: string[];
  observed_write_set: string[];
  assurance: TransactionAssurancePlan;
}

const INVALID = 'SOURCE_TRANSACTION_INVALID';

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isData(value)) throw new Error(INVALID);
  assertExactKeys(value, keys, [], INVALID);
  return value;
}

function strings(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item || item.includes('\0')) ||
    new Set(value).size !== value.length
  )
    throw new Error(INVALID);
}

function paths(value: unknown): asserts value is string[] {
  strings(value);
  if (
    value.some(
      (path) =>
        path.startsWith('/') ||
        path.includes('\\') ||
        /^[A-Za-z]:/.test(path) ||
        [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        path.split('/').some((part) => !part || ['.', '..', '.git'].includes(part)),
    )
  )
    throw new Error(INVALID);
}

function sha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(INVALID);
}

function writeScope(value: unknown): AuthorizedSourceWriteScope {
  const scope = record(value, [
    'allowed_roots',
    'allowed_paths',
    'denied_roots',
    'denied_paths',
    'max_changed_files',
    'max_changed_bytes',
  ]);
  for (const key of ['allowed_roots', 'allowed_paths', 'denied_roots', 'denied_paths'] as const) {
    paths(scope[key]);
  }
  if (
    (scope.allowed_roots as string[]).length + (scope.allowed_paths as string[]).length === 0 ||
    !isPositiveSafeInteger(scope.max_changed_files) ||
    (scope.max_changed_bytes !== null && !isPositiveSafeInteger(scope.max_changed_bytes))
  ) {
    throw new Error(INVALID);
  }
  return structuredClone(scope) as unknown as AuthorizedSourceWriteScope;
}

function samePaths(left: string[], right: string[]): boolean {
  return canonicalDigest([...left].sort()) === canonicalDigest([...right].sort());
}

export function validateSourceTransactionPlan(value: unknown): SourceTransactionPlan {
  const plan = record(value, [
    'schema',
    'schema_version',
    'repository_id',
    'repository_full_name',
    'runtime_sha',
    'claim',
    'candidate_sha',
    'candidate_tree',
    'verification_profile',
    'authorized_write_scope',
    'expected_write_set',
    'observed_write_set',
    'assurance',
  ]);
  if (
    plan.schema !== 'overcenter-source-transaction' ||
    plan.schema_version !== 3 ||
    !isPositiveSafeInteger(plan.repository_id) ||
    typeof plan.repository_full_name !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plan.repository_full_name)
  )
    throw new Error(INVALID);

  sha(plan.runtime_sha);
  sha(plan.candidate_sha);
  sha(plan.candidate_tree);
  const profile = record(plan.verification_profile, ['profile', 'sha256']);
  const verifiedProfile = validateSourceVerificationProfile(profile.profile);
  const profileBinding = sourceVerificationProfileBinding(verifiedProfile);
  if (profile.sha256 !== profileBinding.sha256) throw new Error(INVALID);
  const claim = record(plan.claim, ['obligation_key', 'run_id', 'claimed_revision', 'source_sha']);
  for (const key of ['obligation_key', 'run_id', 'claimed_revision'])
    assertNonEmptyString(claim[key], INVALID);
  sha(claim.source_sha);
  bindSourceClaim(
    claim.obligation_key as string,
    claim.run_id as string,
    claim.claimed_revision as string,
    claim.source_sha,
  );

  const scope = writeScope(plan.authorized_write_scope);
  paths(plan.expected_write_set);
  paths(plan.observed_write_set);
  if (
    !plan.expected_write_set.length ||
    plan.expected_write_set.length > scope.max_changed_files ||
    plan.expected_write_set.some(
      (path) => !sourceWriteScopeAllowsPath(scope, path, verifiedProfile.protected_paths),
    )
  ) {
    throw new Error('SOURCE_TRANSACTION_SCOPE');
  }
  if (!samePaths(plan.expected_write_set, plan.observed_write_set)) {
    throw new Error('SOURCE_TRANSACTION_DIVERGED');
  }

  const assurance = record(plan.assurance, [
    'base_revision',
    'candidate_revision',
    'candidate_tree',
    'model_sha256',
    'dependency_sha256',
    'changed_artifacts',
    'impacts',
    'proof_plans',
    'evidence',
    'coverage_gaps',
    'validation_mode',
    'baseline_id',
    'baseline_sha256',
  ]);
  if (
    assurance.base_revision !== claim.source_sha ||
    assurance.candidate_revision !== plan.candidate_sha ||
    assurance.candidate_tree !== plan.candidate_tree ||
    !isSha256Hex(assurance.model_sha256) ||
    !isSha256Hex(assurance.dependency_sha256)
  )
    throw new Error(INVALID);

  paths(assurance.changed_artifacts);
  if (!samePaths(assurance.changed_artifacts, plan.observed_write_set))
    throw new Error('SOURCE_TRANSACTION_DIVERGED');
  if (
    !['selective', 'baseline', 'unsupported'].includes(assurance.validation_mode as string) ||
    !Array.isArray(assurance.coverage_gaps)
  )
    throw new Error(INVALID);

  for (const gap of assurance.coverage_gaps) {
    const item = record(gap, ['artifact_id', 'reason']);
    paths([item.artifact_id]);
    if (
      ![
        'unmodeled-artifact',
        'unsupported-language',
        'unresolved-dependency',
        'source-unavailable',
        'evidence-unmapped',
        'model-changed',
        'validator-changed',
      ].includes(item.reason as string)
    )
      throw new Error(INVALID);
  }

  if ((assurance.baseline_id === null) !== (assurance.baseline_sha256 === null))
    throw new Error(INVALID);
  if (assurance.baseline_id !== null) {
    assertNonEmptyString(assurance.baseline_id, INVALID);
    if (!isSha256Hex(assurance.baseline_sha256)) throw new Error(INVALID);
  }
  if (
    (assurance.validation_mode === 'selective' && assurance.coverage_gaps.length) ||
    (assurance.validation_mode === 'baseline' && assurance.baseline_id === null)
  )
    throw new Error(INVALID);

  if (!Array.isArray(assurance.impacts) || !Array.isArray(assurance.proof_plans))
    throw new Error(INVALID);
  for (const impact of assurance.impacts) {
    const item = record(impact, ['property_id', 'changed_artifacts', 'direct', 'via_properties']);
    assertNonEmptyString(item.property_id, INVALID);
    paths(item.changed_artifacts);
    strings(item.via_properties);
    if (typeof item.direct !== 'boolean') throw new Error(INVALID);
  }

  const validateEvidence = (input: unknown): void => {
    if (!Array.isArray(input)) throw new Error(INVALID);
    for (const evidence of input) {
      const item = record(evidence, ['evidence_id', 'obligation_ids', 'artifact_ids']);
      assertNonEmptyString(item.evidence_id, INVALID);
      strings(item.obligation_ids);
      paths(item.artifact_ids);
    }
  };
  validateEvidence(assurance.evidence);

  for (const proofPlan of assurance.proof_plans) {
    const item = record(proofPlan, [
      'properties',
      'effects',
      'obligations',
      'evidence',
      'realization_roots',
    ]);
    strings(item.properties);
    strings(item.effects);
    strings(item.obligations);
    validateEvidence(item.evidence);
    if (!Array.isArray(item.realization_roots)) throw new Error(INVALID);
    for (const root of item.realization_roots) {
      const entry = record(root, ['artifact_id', 'symbol_id', 'basis', 'requirement_id']);
      paths([entry.artifact_id]);
      assertNonEmptyString(entry.symbol_id, INVALID);
      assertNonEmptyString(entry.requirement_id, INVALID);
      if (!['authority', 'capability', 'effect'].includes(entry.basis as string))
        throw new Error(INVALID);
    }
  }

  return structuredClone(plan) as unknown as SourceTransactionPlan;
}

export function sourceTransactionPlanDigest(plan: SourceTransactionPlan): string {
  return canonicalDigest({
    domain: 'overcenter-source-transaction/v2',
    plan: validateSourceTransactionPlan(plan),
  });
}

export function sourceTransactionPlanRef(plan: SourceTransactionPlan): EvidenceRef {
  return evidenceRef(Buffer.from(canonicalJson(validateSourceTransactionPlan(plan))));
}

export function validateSourceTransactionTask(
  plan: SourceTransactionPlan,
  taskValue: unknown,
): void {
  const task = validateSourceTaskPacket(taskValue);
  if (
    canonicalDigest(plan.authorized_write_scope) !==
    canonicalDigest(authorizedSourceWriteScope(task))
  ) {
    throw new Error('SOURCE_TRANSACTION_TASK_MISMATCH');
  }
}

export function buildSourceTransactionPlan({
  repo,
  taskValue,
  claim,
  candidateSha,
  context,
}: {
  repo: string;
  taskValue: unknown;
  claim: SourceClaimBinding;
  candidateSha: string;
  context: SourceTransactionContext;
}): SourceTransactionPlan {
  validateSourceTransactionContext(context);

  const parents = execFileSync(
    'git',
    ['-C', repo, 'rev-list', '--parents', '-n', '1', candidateSha],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\s+/);
  if (parents.length !== 2 || parents[1] !== claim.source_sha)
    throw new Error('SOURCE_TRANSACTION_PARENT_MISMATCH');

  const task = validateSourceTaskPacket(taskValue);
  const profile = readSourceVerificationProfile(repo, claim.source_sha);
  const delta = observeRepositoryDelta(repo, claim.source_sha, candidateSha);
  assertSupportedSourceDelta(delta);
  const scope = authorizedSourceWriteScope(task);
  const changedPaths = delta.entries.map((entry) => entry.path);
  if (
    changedPaths.length === 0 ||
    changedPaths.length > scope.max_changed_files ||
    changedPaths.some(
      (path) => !sourceWriteScopeAllowsPath(scope, path, profile.profile.protected_paths),
    )
  ) {
    throw new Error('SOURCE_TRANSACTION_SCOPE');
  }
  if (
    scope.max_changed_bytes !== null &&
    repositoryDeltaChangedBytes(repo, delta) > scope.max_changed_bytes
  ) {
    throw new Error('SOURCE_CHANGE_BUDGET_BYTES_EXCEEDED');
  }
  const assurance = baselineSourceTransactionPlan(repo, delta, profile.profile);
  if (assurance.validation_mode === 'unsupported')
    throw new Error('SOURCE_TRANSACTION_RECONCILIATION_REQUIRED');

  const plan = validateSourceTransactionPlan({
    schema: 'overcenter-source-transaction',
    schema_version: 3,
    repository_id: context.repository_id,
    repository_full_name: context.repository_full_name,
    runtime_sha: context.runtime_sha,
    claim,
    candidate_sha: candidateSha,
    candidate_tree: delta.candidate_tree,
    verification_profile: { profile: profile.profile, sha256: profile.sha256 },
    authorized_write_scope: scope,
    expected_write_set: changedPaths,
    observed_write_set: changedPaths,
    assurance,
  });
  validateSourceTransactionTask(plan, task);
  return plan;
}
