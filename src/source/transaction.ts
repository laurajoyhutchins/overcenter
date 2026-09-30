import { canonicalDigest, canonicalJson } from '../digest.ts';
import { evidenceRef, validateEvidenceRef, type EvidenceRef } from '../evidence/reference.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isPositiveSafeInteger,
  isSha256Hex,
} from '../validation.ts';
import {
  validateSourceTaskPacket,
  bindSourceClaim,
  type SourceClaimBinding,
} from './source-obligation.ts';

export interface SourceTransactionAssurancePlan {
  base_revision: string;
  candidate_revision: string;
  candidate_tree: string;
  model_sha256: string;
  dependency_sha256: string;
  changed_artifacts: string[];
  impacts: Array<{
    property_id: string;
    changed_artifacts: string[];
    direct: boolean;
    via_properties: string[];
  }>;
  proof_plans: Array<{
    properties: string[];
    effects: string[];
    obligations: string[];
    evidence: Array<{ evidence_id: string; obligation_ids: string[]; artifact_ids: string[] }>;
    realization_roots: Array<{
      artifact_id: string;
      symbol_id: string;
      basis: 'authority' | 'capability' | 'effect';
      requirement_id: string;
    }>;
  }>;
  evidence: Array<{ evidence_id: string; obligation_ids: string[]; artifact_ids: string[] }>;
  coverage_gaps: Array<{
    artifact_id: string;
    reason:
      | 'unmodeled-artifact'
      | 'unsupported-language'
      | 'unresolved-dependency'
      | 'source-unavailable'
      | 'evidence-unmapped'
      | 'model-changed'
      | 'validator-changed';
  }>;
  validation_mode: 'selective' | 'baseline' | 'unsupported';
  baseline_id: string | null;
  baseline_sha256: string | null;
}

export interface SourceTransactionPlan {
  schema: 'overcenter-source-transaction';
  schema_version: 1;
  repository_id: number;
  repository_full_name: string;
  runtime_sha: string;
  claim: SourceClaimBinding;
  execution_generation: number;
  execution_authority_commit: string;
  candidate_sha: string;
  candidate_tree: string;
  authorized_write_set: string[];
  expected_write_set: string[];
  observed_write_set: string[];
  assurance: SourceTransactionAssurancePlan;
}

export const SOURCE_TRANSACTION_BINDING_SCHEMA = 'overcenter-source-transaction-binding' as const;
export interface SourceTransactionBindingFact {
  schema: typeof SOURCE_TRANSACTION_BINDING_SCHEMA;
  schema_version: 1;
  run_id: string;
  obligation_id: string;
  execution_generation: number;
  execution_authority_commit: string;
  plan: SourceTransactionPlan;
  plan_digest: string;
  plan_ref: EvidenceRef;
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
    'execution_generation',
    'execution_authority_commit',
    'candidate_sha',
    'candidate_tree',
    'authorized_write_set',
    'expected_write_set',
    'observed_write_set',
    'assurance',
  ]);
  if (
    plan.schema !== 'overcenter-source-transaction' ||
    plan.schema_version !== 1 ||
    !isPositiveSafeInteger(plan.repository_id) ||
    !isPositiveSafeInteger(plan.execution_generation) ||
    typeof plan.repository_full_name !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plan.repository_full_name)
  )
    throw new Error(INVALID);
  sha(plan.runtime_sha);
  sha(plan.candidate_sha);
  sha(plan.candidate_tree);
  assertNonEmptyString(plan.execution_authority_commit, INVALID);
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
  paths(plan.authorized_write_set);
  paths(plan.expected_write_set);
  paths(plan.observed_write_set);
  const authorized = plan.authorized_write_set;
  if (
    !plan.expected_write_set.length ||
    plan.expected_write_set.some((path) => !authorized.includes(path))
  )
    throw new Error('SOURCE_TRANSACTION_SCOPE');
  if (!samePaths(plan.expected_write_set, plan.observed_write_set))
    throw new Error('SOURCE_TRANSACTION_DIVERGED');
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
  const validateEvidence = (value: unknown): void => {
    if (!Array.isArray(value)) throw new Error(INVALID);
    for (const evidence of value) {
      const item = record(evidence, ['evidence_id', 'obligation_ids', 'artifact_ids']);
      assertNonEmptyString(item.evidence_id, INVALID);
      strings(item.obligation_ids);
      paths(item.artifact_ids);
    }
  };
  validateEvidence(assurance.evidence);
  for (const proof of assurance.proof_plans) {
    const item = record(proof, [
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
    domain: 'overcenter-source-transaction/v1',
    plan: validateSourceTransactionPlan(plan),
  });
}
export function sourceTransactionPlanRef(plan: SourceTransactionPlan): EvidenceRef {
  return evidenceRef(Buffer.from(canonicalJson(validateSourceTransactionPlan(plan))));
}
export function validateSourceTransactionBindingFact(value: unknown): SourceTransactionBindingFact {
  const fact = record(value, [
    'schema',
    'schema_version',
    'run_id',
    'obligation_id',
    'execution_generation',
    'execution_authority_commit',
    'plan',
    'plan_digest',
    'plan_ref',
  ]);
  const plan = validateSourceTransactionPlan(fact.plan);
  const ref = validateEvidenceRef(fact.plan_ref);
  assertNonEmptyString(fact.obligation_id, INVALID);
  if (
    fact.schema !== SOURCE_TRANSACTION_BINDING_SCHEMA ||
    fact.schema_version !== 1 ||
    fact.run_id !== plan.claim.run_id ||
    fact.execution_generation !== plan.execution_generation ||
    fact.execution_authority_commit !== plan.execution_authority_commit ||
    fact.plan_digest !== sourceTransactionPlanDigest(plan) ||
    canonicalDigest(ref) !== canonicalDigest(sourceTransactionPlanRef(plan))
  )
    throw new Error(INVALID);
  return structuredClone(fact) as unknown as SourceTransactionBindingFact;
}

export function validateSourceTransactionTask(
  plan: SourceTransactionPlan,
  taskValue: unknown,
): void {
  const task = validateSourceTaskPacket(taskValue);
  if (
    !samePaths(plan.authorized_write_set, task.writable_paths) ||
    (task.expected_write_set && !samePaths(plan.expected_write_set, task.expected_write_set)) ||
    (!task.expected_write_set && plan.assurance.validation_mode !== 'baseline')
  )
    throw new Error('SOURCE_TRANSACTION_TASK_MISMATCH');
}
