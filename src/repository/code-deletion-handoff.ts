import { normalizeObligation, type ObligationInput } from '../authority/facts.ts';
import { canonicalDigest, sha256 } from '../digest.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../effect-adapter.ts';
import {
  SOURCE_PROPOSAL_SCHEMA,
  SOURCE_TASK_SCHEMA,
  validateSourceAssignment,
  validateSourceProposal,
  validateSourceTaskPacket,
  type SourceClaimBinding,
  type SourceProposal,
  type SourceTaskPacket,
} from '../source/source-obligation.ts';
import { assertExactKeys, isData } from '../validation.ts';
import {
  parseCodeSymbolSelector,
  validateCounterfactualDeletionProof,
  type CounterfactualDeletionProof,
} from './code-deletion-proof.ts';

export const CODE_DELETION_HANDOFF_SCHEMA = 'overcenter-code-deletion-handoff/v1' as const;
export const PROVEN_CODE_DELETION_CONTEXT_SCHEMA =
  'overcenter-proven-code-deletion-context/v1' as const;

export interface CodeDeletionHandoff {
  schema: typeof CODE_DELETION_HANDOFF_SCHEMA;
  proof: CounterfactualDeletionProof;
  proof_sha256: string;
  path: string;
  candidate_content_base64: string;
}

interface ProvenCodeDeletionContext extends Record<string, unknown> {
  schema: typeof PROVEN_CODE_DELETION_CONTEXT_SCHEMA;
  kind: 'proven-code-deletion';
  proof: CounterfactualDeletionProof;
  proof_sha256: string;
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

function taskContext(proof: CounterfactualDeletionProof): ProvenCodeDeletionContext {
  return {
    schema: PROVEN_CODE_DELETION_CONTEXT_SCHEMA,
    kind: 'proven-code-deletion',
    proof,
    proof_sha256: canonicalDigest(proof),
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
    context: taskContext(handoff.proof),
  });
}

export function provenCodeDeletionProofFromTask(
  taskValue: unknown,
): CounterfactualDeletionProof | null {
  const task = validateSourceTaskPacket(taskValue);
  if (task.context?.kind !== 'proven-code-deletion') return null;
  const context = task.context;
  assertExactKeys(
    context,
    ['schema', 'kind', 'proof', 'proof_sha256'],
    [],
    'PROVEN_CODE_DELETION_CONTEXT_INVALID',
  );
  if (context.schema !== PROVEN_CODE_DELETION_CONTEXT_SCHEMA) {
    throw new Error('PROVEN_CODE_DELETION_CONTEXT_SCHEMA_MISMATCH');
  }
  const proof = acceptedProof(context.proof);
  if (context.proof_sha256 !== canonicalDigest(proof)) {
    throw new Error('PROVEN_CODE_DELETION_PROOF_DIGEST_MISMATCH');
  }
  const parsed = parseCodeSymbolSelector(proof.selector);
  if (
    task.writable_paths.length !== 1 ||
    task.writable_paths[0] !== parsed.path ||
    task.acceptance !== undefined ||
    task.objective !== `Delete proof-backed unwitnessed production symbol ${proof.selector}.`
  ) {
    throw new Error('PROVEN_CODE_DELETION_TASK_MISMATCH');
  }
  return proof;
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

export function validateProvenCodeDeletionProposalBinding(
  taskValue: unknown,
  claim: SourceClaimBinding,
  proposalValue: unknown,
  originalSource: Uint8Array,
): SourceProposal | null {
  const proof = provenCodeDeletionProofFromTask(taskValue);
  if (!proof) return null;
  if (claim.source_sha !== proof.source_revision) {
    throw new Error('PROVEN_CODE_DELETION_CLAIM_SOURCE_MISMATCH');
  }
  if (sha256(originalSource) !== proof.source_sha256) {
    throw new Error('PROVEN_CODE_DELETION_ORIGINAL_DIGEST_MISMATCH');
  }
  const proposal = validateSourceProposal(proposalValue, taskValue, claim);
  const parsed = parseCodeSymbolSelector(proof.selector);
  if (
    proposal.files.length !== 1 ||
    proposal.files[0]?.path !== parsed.path ||
    proposal.files[0].content_base64 === null
  ) {
    throw new Error('PROVEN_CODE_DELETION_PROPOSAL_SHAPE_MISMATCH');
  }
  const candidate = Buffer.from(proposal.files[0].content_base64, 'base64');
  if (sha256(candidate) !== proof.candidate_source_sha256) {
    throw new Error('PROVEN_CODE_DELETION_CANDIDATE_DIGEST_MISMATCH');
  }
  return proposal;
}
