import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/digest.ts';
import {
  buildCodeDeletionHandoff,
  buildProvenCodeDeletionSourceProposal,
  buildProvenCodeDeletionSourceTask,
  compileProvenCodeDeletionObligation,
  validateCodeDeletionHandoff,
} from '../src/repository/code-deletion-handoff.ts';
import {
  buildCounterfactualDeletionProof,
  CODE_DELETION_EVIDENCE_STEPS,
} from '../src/repository/code-deletion-proof.ts';
import {
  bindSourceClaim,
  buildSourceAssignment,
  validateSourceProposal,
} from '../src/source/source-obligation.ts';

const sourceRevision = 'a'.repeat(40);
const candidateRevision = 'b'.repeat(40);
const original = 'function dead() { return 1; }\nexport const live = 2;\n';
const candidate = 'export const live = 2;\n';

function proof() {
  return buildCounterfactualDeletionProof({
    source_revision: sourceRevision,
    candidate_revision: candidateRevision,
    selector: 'src/example.ts#dead',
    source_sha256: sha256(original),
    candidate_source_sha256: sha256(candidate),
    evidence: CODE_DELETION_EVIDENCE_STEPS.map((name) => ({ name, passed: true })),
  });
}

test('successful proof becomes a content-addressed one-file handoff', () => {
  const handoff = buildCodeDeletionHandoff(proof(), candidate);
  assert.equal(handoff.path, 'src/example.ts');
  assert.equal(Buffer.from(handoff.candidate_content_base64, 'base64').toString('utf8'), candidate);
  assert.deepEqual(validateCodeDeletionHandoff(handoff), handoff);

  const obligation = compileProvenCodeDeletionObligation(handoff);
  assert.equal(obligation.id, 'code-deletion:' + handoff.proof_sha256);
  assert.ok(obligation.packet);
  assert.deepEqual(obligation.packet.writable_paths, ['src/example.ts']);
});

test('proof-backed task and proposal remain claim-bound', () => {
  const handoff = buildCodeDeletionHandoff(proof(), candidate);
  const task = buildProvenCodeDeletionSourceTask(handoff);
  const claim = bindSourceClaim('semantic-key', 'run-1', 'authority-head', sourceRevision);
  const assignment = buildSourceAssignment('code-deletion:test', task, claim);
  const proposal = buildProvenCodeDeletionSourceProposal(assignment, handoff);

  assert.equal(task.context?.kind, 'exact-source-proposal');
  assert.deepEqual(validateSourceProposal(proposal, task, claim), proposal);
});

test('candidate substitution fails the generic exact-proposal binding', () => {
  const handoff = buildCodeDeletionHandoff(proof(), candidate);
  const task = buildProvenCodeDeletionSourceTask(handoff);
  const claim = bindSourceClaim('semantic-key', 'run-1', 'authority-head', sourceRevision);
  const assignment = buildSourceAssignment('code-deletion:test', task, claim);
  const proposal = buildProvenCodeDeletionSourceProposal(assignment, handoff);

  const substituted = structuredClone(proposal);
  substituted.files[0]!.content_base64 = Buffer.from('export const live = 3;\n').toString('base64');
  assert.throws(
    () => validateSourceProposal(substituted, task, claim),
    /SOURCE_PROPOSAL_EXACT_BINDING_MISMATCH/,
  );
});

test('rejected proof cannot acquire a source-change handoff', () => {
  const rejected = buildCounterfactualDeletionProof({
    source_revision: sourceRevision,
    candidate_revision: candidateRevision,
    selector: 'src/example.ts#dead',
    source_sha256: sha256(original),
    candidate_source_sha256: sha256(candidate),
    evidence: [{ name: 'lint', passed: false }],
  });
  assert.throws(() => buildCodeDeletionHandoff(rejected, candidate), /PROOF_REJECTED/);
});
