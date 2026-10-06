import {
  executionEvidenceReceipt,
  executionEvidenceReceiptDigest,
  normalizeExecutionEvidenceReceipt,
  sameExecutionEvidenceReceipt,
  type ExecutionEvidenceReceipt,
} from '../execution/evidence-receipt.ts';
import { assertExactKeys, assertNonEmptyString, isData, isSha256Hex } from '../validation.ts';
import {
  sourceProofExecutionEvidenceDescriptor,
  sourceProofExecutionEvidenceRealization,
} from './source-proof-evidence.ts';
export interface AdmittedSourceProof {
  schema: 'overcenter-admitted-source-proof/v3';
  state: 'verified';
  reason: null;
  run_id: string;
  candidate_sha: string;
  base_sha: string;
  tree_sha: string;
  runtime_sha: string;
  plan_digest: string;
  verification_profile_id: string;
  verification_profile_sha256: string;
  execution_evidence_sha256: string;
}

export interface SourceProofContext {
  repository_id: number;
  repository_full_name: string;
  runtime_sha: string;
  verification_profile_id: string;
  verification_profile_sha256: string;
}

import {
  sourceTransactionPlanDigest,
  validateSourceTransactionPlan,
  type SourceTransactionPlan,
} from './transaction.ts';

export {
  sourceProofExecutionEvidenceDescriptor,
  sourceProofExecutionEvidenceRealization,
} from './source-proof-evidence.ts';

export class SourceProofRejected extends Error {
  constructor() {
    super('SOURCE_VERIFICATION_FAILED');
    this.name = 'SourceProofRejected';
  }
}

const proofs = new WeakMap<object, AdmittedSourceProof>();
declare const sourceProofBrand: unique symbol;
export type TrustedSourceProofWitness = { readonly [sourceProofBrand]: true };

function exactSha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('SOURCE_PROOF_BINDING_MISMATCH');
  }
}

export function admitSourceProofEvidence(
  planValue: SourceTransactionPlan,
  {
    executionEvidence,
    context,
  }: {
    executionEvidence: ExecutionEvidenceReceipt;
    context: SourceProofContext;
  },
): TrustedSourceProofWitness {
  const plan = validateSourceTransactionPlan(planValue);
  if (
    context.repository_id !== plan.repository_id ||
    context.repository_full_name !== plan.repository_full_name ||
    context.runtime_sha !== plan.runtime_sha ||
    context.verification_profile_id !== plan.verification_profile.profile.id ||
    context.verification_profile_sha256 !== plan.verification_profile.sha256
  ) {
    throw new Error('SOURCE_PROOF_BINDING_MISMATCH');
  }

  const observed = normalizeExecutionEvidenceReceipt(executionEvidence);
  const descriptor = sourceProofExecutionEvidenceDescriptor(plan);
  const expected = executionEvidenceReceipt(
    descriptor,
    sourceProofExecutionEvidenceRealization(plan, observed.observation.result),
  );
  if (!sameExecutionEvidenceReceipt(observed, expected)) {
    throw new Error('SOURCE_PROOF_EXECUTION_EVIDENCE_MISMATCH');
  }

  if (observed.observation.result === 'unsatisfied') throw new SourceProofRejected();

  const proof = validateAdmittedSourceProof({
    schema: 'overcenter-admitted-source-proof/v3',
    state: 'verified',
    reason: null,
    run_id: plan.claim.run_id,
    candidate_sha: plan.candidate_sha,
    base_sha: plan.claim.source_sha,
    tree_sha: plan.candidate_tree,
    runtime_sha: plan.runtime_sha,
    plan_digest: sourceTransactionPlanDigest(plan),
    verification_profile_id: plan.verification_profile.profile.id,
    verification_profile_sha256: plan.verification_profile.sha256,
    execution_evidence_sha256: executionEvidenceReceiptDigest(observed),
  });
  const witness = Object.freeze({}) as TrustedSourceProofWitness;
  proofs.set(witness, proof);
  return witness;
}

export function trustedSourceProof(witness: TrustedSourceProofWitness): AdmittedSourceProof {
  const proof = proofs.get(witness);
  if (!proof) throw new Error('SOURCE_PROOF_WITNESS_INVALID');
  return structuredClone(proof);
}

export function validateAdmittedSourceProof(value: unknown): AdmittedSourceProof {
  if (!isData(value)) throw new Error('SOURCE_PROOF_RECORD_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'state',
      'reason',
      'run_id',
      'candidate_sha',
      'base_sha',
      'tree_sha',
      'runtime_sha',
      'plan_digest',
      'verification_profile_id',
      'verification_profile_sha256',
      'execution_evidence_sha256',
    ],
    [],
    'SOURCE_PROOF_RECORD_INVALID',
  );
  if (
    value.schema !== 'overcenter-admitted-source-proof/v3' ||
    value.state !== 'verified' ||
    value.reason !== null ||
    !isSha256Hex(value.plan_digest) ||
    !isSha256Hex(value.verification_profile_sha256) ||
    !isSha256Hex(value.execution_evidence_sha256)
  ) {
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  }
  assertNonEmptyString(value.run_id, 'SOURCE_PROOF_RECORD_INVALID');
  assertNonEmptyString(value.verification_profile_id, 'SOURCE_PROOF_RECORD_INVALID');
  for (const field of [value.candidate_sha, value.base_sha, value.tree_sha, value.runtime_sha]) {
    exactSha(field);
  }
  return structuredClone(value) as unknown as AdmittedSourceProof;
}
