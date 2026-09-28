import { normalizeObligation, type ObligationInput } from '../authority/facts.ts';
import { canonicalDigest, sha256 } from '../digest.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../effect-adapter.ts';
import {
  EXACT_SOURCE_PROPOSAL_CONTEXT_SCHEMA,
  SOURCE_PROPOSAL_SCHEMA,
  SOURCE_TASK_SCHEMA,
  validateSourceAssignment,
  validateSourceProposal,
  validateSourceTaskPacket,
  type SourceProposal,
  type SourceTaskPacket,
} from '../source/source-obligation.ts';
import {
  parseCodeSymbolSelector,
  validateCounterfactualDeletionProof,
  type CounterfactualDeletionProof,
} from './code-deletion-proof.ts';

export const CODE_DELETION_HANDOFF_SCHEMA = 'overcenter-code-deletion-handoff/v1' as const;
export interface CodeDeletionHandoff {
  schema: typeof CODE_DELETION_HANDOFF_SCHEMA;
  proof: CounterfactualDeletionProof;
  proof_sha256: string;
  path: string;
  candidate_content_base64: string;
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function acceptedProof(value: unknown): CounterfactualDeletionProof {
  const proof = validateCounterfactualDeletionProof(value);
  if (
    proof.status !== 'deterministic-evidence-preserved' ||
    proof.reason_code !== 'ALL_DETERMINISTIC_EVIDENCE_PASSED'
  ) {
    throw new Error('CODE_DELETION_HANDOFF_PROOF_REJECTED');
  }
  return proof;
}

export function buildCodeDeletionHandoff(
  proofValue: unknown,
  candidateSource: string | Uint8Array,
): CodeDeletionHandoff {
  const proof = acceptedProof(proofValue);
  const parsed = parseCodeSymbolSelector(proof.selector);
  const bytes =
    typeof candidateSource === 'string' ? Buffer.from(candidateSource, 'utf8') : candidateSource;
  if (sha256(bytes) !== proof.candidate_source_sha256) {
    throw new Error('CODE_DELETION_HANDOFF_CANDIDATE_DIGEST_MISMATCH');
  }
  return {
    schema: CODE_DELETION_HANDOFF_SCHEMA,
    proof,
    proof_sha256: canonicalDigest(proof),
    path: parsed.path,
    candidate_content_base64: Buffer.from(bytes).toString('base64'),
  };
}

export function validateCodeDeletionHandoff(value: unknown): CodeDeletionHandoff {
  if (!isData(value)) throw new Error('CODE_DELETION_HANDOFF_INVALID');
  assertExactKeys(
    value,
    ['schema', 'proof', 'proof_sha256', 'path', 'candidate_content_base64'],
    [],
    'CODE_DELETION_HANDOFF_INVALID',
  );
  if (value.schema !== CODE_DELETION_HANDOFF_SCHEMA) {
    throw new Error('CODE_DELETION_HANDOFF_SCHEMA_MISMATCH');
  }
  const proof = acceptedProof(value.proof);
  const parsed = parseCodeSymbolSelector(proof.selector);
  if (value.path !== parsed.path) throw new Error('CODE_DELETION_HANDOFF_PATH_MISMATCH');
  if (value.proof_sha256 !== canonicalDigest(proof)) {
    throw new Error('CODE_DELETION_HANDOFF_PROOF_DIGEST_MISMATCH');
  }
  if (!canonicalBase64(value.candidate_content_base64)) {
    throw new Error('CODE_DELETION_HANDOFF_CONTENT_INVALID');
  }
  const candidate = Buffer.from(value.candidate_content_base64, 'base64');
  if (sha256(candidate) !== proof.candidate_source_sha256) {
    throw new Error('CODE_DELETION_HANDOFF_CANDIDATE_DIGEST_MISMATCH');
  }
  return {
    schema: CODE_DELETION_HANDOFF_SCHEMA,
    proof,
    proof_sha256: value.proof_sha256,
    path: parsed.path,
    candidate_content_base64: value.candidate_content_base64,
  };
}

export function buildProvenCodeDeletionSourceTask(handoffValue: unknown): SourceTaskPacket {
  const handoff = validateCodeDeletionHandoff(handoffValue);
  return validateSourceTaskPacket({
    schema: SOURCE_TASK_SCHEMA,
    kind: 'source-change',
    objective: `Delete proof-backed unwitnessed production symbol ${handoff.proof.selector}.`,
    writable_paths: [handoff.path],
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    context: {
      schema: EXACT_SOURCE_PROPOSAL_CONTEXT_SCHEMA,
      kind: 'exact-source-proposal',
      path: handoff.path,
      content_base64: handoff.candidate_content_base64,
      provenance_sha256: handoff.proof_sha256,
    },
  });
}

export function compileProvenCodeDeletionObligation(handoffValue: unknown): ObligationInput {
  const handoff = validateCodeDeletionHandoff(handoffValue);
  return normalizeObligation({
    id: `code-deletion:${handoff.proof_sha256}`,
    packet: buildProvenCodeDeletionSourceTask(handoff),
    postcondition: { verifier: 'source-integration/v1' },
  });
}

export function buildProvenCodeDeletionSourceProposal(
  assignmentValue: unknown,
  handoffValue: unknown,
): SourceProposal {
  const assignment = validateSourceAssignment(assignmentValue);
  const handoff = validateCodeDeletionHandoff(handoffValue);
  const expectedTask = buildProvenCodeDeletionSourceTask(handoff);
  if (canonicalDigest(assignment.task) !== canonicalDigest(expectedTask)) {
    throw new Error('PROVEN_CODE_DELETION_ASSIGNMENT_TASK_MISMATCH');
  }
  if (assignment.claim.source_sha !== handoff.proof.source_revision) {
    throw new Error('PROVEN_CODE_DELETION_ASSIGNMENT_SOURCE_MISMATCH');
  }
  return validateSourceProposal(
    {
      schema: SOURCE_PROPOSAL_SCHEMA,
      run_id: assignment.claim.run_id,
      claimed_revision: assignment.claim.claimed_revision,
      claimed_source_sha: assignment.claim.source_sha,
      files: [
        {
          path: handoff.path,
          content_base64: handoff.candidate_content_base64,
        },
      ],
    },
    assignment.task,
    assignment.claim,
  );
}
