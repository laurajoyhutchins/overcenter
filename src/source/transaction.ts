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
import { assertSupportedSourceDelta, observeRepositoryDelta } from './repository-delta.ts';
import {
  baselineSourceTransactionPlan,
  validateSourceTransactionContext,
  type SourceTransactionContext,
} from './transaction-baseline.ts';
import {
  assertSourceWriteEnvelope,
  normalizeSourceWriteEnvelope,
  validateSourceTaskPacket,
  bindSourceClaim,
  type SourceClaimBinding,
  type SourceWriteEnvelope,
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
  write_envelope: SourceWriteEnvelope;
  authorized_write_set: string[];
  expected_write_set: string[];
  observed_write_set: string[];
  observed_write_bytes: number;
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
    'write_envelope',
    'authorized_write_set',
    'expected_write_set',
    'observed_write_set',
    'observed_write_bytes',
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
  paths(plan.authorized_write_set);
  paths(plan.expected_write_set);
  paths(plan.observed_write_set);
  const writeEnvelope = normalizeSourceWriteEnvelope({
    writable_paths: (plan.authorized_write_set as string[] | undefined) ?? [],
    write_envelope: plan.write_envelope,
  });
  if (!samePaths(plan.authorized_write_set as string[], writeEnvelope.exact_paths))
    throw new Error(INVALID);
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

  if (!plan.expected_write_set.length) throw new Error('SOURCE_TRANSACTION_SCOPE');
  if (!samePaths(plan.expected_write_set, plan.observed_write_set))
    throw new Error('SOURCE_TRANSACTION_DIVERGED');
  if (!Number.isSafeInteger(plan.observed_write_bytes) || plan.observed_write_bytes < 0)
    throw new Error(INVALID);
  try {
    assertSourceWriteEnvelope(
      {
        writable_paths: plan.authorized_write_set,
        write_envelope: writeEnvelope,
      },
      plan.expected_write_set.map((path, index) => ({
        path,
        changed_bytes: index === 0 ? plan.observed_write_bytes : 0,
      })),
      verifiedProfile.protected_paths,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SOURCE_PROPOSAL_SCOPE_VIOLATION:'))
      throw new Error('SOURCE_TRANSACTION_SCOPE');
    throw error;
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
    'evidence_frontiers',
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

  if (!Array.isArray(assurance.evidence_frontiers)) throw new Error(INVALID);
  for (const frontier of assurance.evidence_frontiers) {
    const item = record(frontier, [
      'coordinate',
      'revision',
      'model_sha256',
      'dependency_sha256',
      'baseline_sha256',
      'required_propositions',
      'candidates',
    ]);
    assertNonEmptyString(item.coordinate, INVALID);
    sha(item.revision);
    if (
      item.coordinate !== `revision:${item.revision}` ||
      (item.revision !== assurance.base_revision &&
        item.revision !== assurance.candidate_revision) ||
      !isSha256Hex(item.model_sha256) ||
      !isSha256Hex(item.dependency_sha256)
    )
      throw new Error(INVALID);
    if (item.baseline_sha256 !== null && !isSha256Hex(item.baseline_sha256))
      throw new Error(INVALID);
    strings(item.required_propositions);
    if (!Array.isArray(item.candidates)) throw new Error(INVALID);
    const required = new Set(item.required_propositions);
    for (const candidate of item.candidates) {
      const entry = record(candidate, [
        'evidence_id',
        'proposition_ids',
        'obligation_ids',
        'artifact_ids',
        'package_scripts',
        'uses_package_runtime',
      ]);
      assertNonEmptyString(entry.evidence_id, INVALID);
      strings(entry.proposition_ids);
      strings(entry.obligation_ids);
      paths(entry.artifact_ids);
      strings(entry.package_scripts);
      if (
        entry.package_scripts.length === 0 ||
        typeof entry.uses_package_runtime !== 'boolean' ||
        entry.proposition_ids.some((proposition) => !required.has(proposition))
      )
        throw new Error(INVALID);
    }
    for (const proposition of item.required_propositions)
      if (
        !item.candidates.some(
          (candidate) =>
            isData(candidate) &&
            Array.isArray(candidate.proposition_ids) &&
            candidate.proposition_ids.includes(proposition),
        )
      )
        throw new Error(INVALID);
  }
  if (
    assurance.validation_mode === 'baseline' &&
    !assurance.evidence_frontiers.some(
      (frontier) =>
        isData(frontier) &&
        frontier.revision === assurance.candidate_revision &&
        frontier.baseline_sha256 === assurance.baseline_sha256,
    )
  )
    throw new Error(INVALID);

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

  return {
    ...structuredClone(plan),
    write_envelope: writeEnvelope,
  } as unknown as SourceTransactionPlan;
}

export function sourceTransactionPlanDigest(plan: SourceTransactionPlan): string {
  return canonicalDigest({
    domain: 'overcenter-source-transaction/v3',
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
    (task.verification_profile_id !== undefined &&
      task.verification_profile_id !== plan.verification_profile.profile.id) ||
    !samePaths(plan.authorized_write_set, task.writable_paths ?? []) ||
    canonicalDigest(plan.write_envelope) !== canonicalDigest(normalizeSourceWriteEnvelope(task))
  )
    throw new Error('SOURCE_TRANSACTION_TASK_MISMATCH');
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
  if (
    task.verification_profile_id !== undefined &&
    task.verification_profile_id !== profile.profile.id
  )
    throw new Error('SOURCE_TRANSACTION_PROFILE_MISMATCH');
  const delta = observeRepositoryDelta(repo, claim.source_sha, candidateSha);
  assertSupportedSourceDelta(delta);
  const blobSize = (objectId: string | undefined) =>
    objectId
      ? Number(
          execFileSync('git', ['-C', repo, 'cat-file', '-s', objectId], {
            encoding: 'utf8',
          }).trim(),
        )
      : 0;
  const changedDelta = delta.entries.map((entry) => ({
    path: entry.path,
    changed_bytes: blobSize(entry.before?.object_id) + blobSize(entry.after?.object_id),
  }));
  const expectedWriteSet = assertSourceWriteEnvelope(
    task,
    changedDelta,
    profile.profile.protected_paths,
  );
  const observedWriteBytes = changedDelta.reduce((sum, entry) => sum + entry.changed_bytes, 0);
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
    write_envelope: normalizeSourceWriteEnvelope(task),
    authorized_write_set: task.writable_paths,
    expected_write_set: expectedWriteSet,
    observed_write_set: expectedWriteSet,
    observed_write_bytes: observedWriteBytes,
    assurance,
  });
  validateSourceTransactionTask(plan, task);
  return plan;
}
