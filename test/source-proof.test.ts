import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  executionEvidenceReceipt,
  executionEvidenceReceiptDigest,
} from '../src/execution/evidence-receipt.ts';
import {
  admitSourceProofEvidence,
  SourceProofRejected,
  sourceProofExecutionEvidenceDescriptor,
  sourceProofExecutionEvidenceRealization,
  trustedSourceProof,
} from '../src/source/source-proof-admission.ts';
import { sourceVerificationProfileBinding } from '../src/source/source-verification-profile.ts';
import type { SourceTransactionPlan } from '../src/source/transaction.ts';

const profile = {
  schema: 'overcenter-source-verification-profile/v2' as const,
  id: 'repository-baseline',
  protected_paths: ['.github', '.overcenter'],
  baseline_test_roots: ['test'],
};

function plan(): SourceTransactionPlan {
  const profileSha256 = sourceVerificationProfileBinding(profile).sha256;
  return {
    schema: 'overcenter-source-transaction',
    schema_version: 2,
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
    claim: {
      obligation_key: 'source:key',
      run_id: 'source-run',
      claimed_revision: 'authority-revision',
      source_sha: 'b'.repeat(40),
    },
    candidate_sha: 'c'.repeat(40),
    candidate_tree: 'd'.repeat(40),
    verification_profile: { profile, sha256: profileSha256 },
    authorized_write_set: ['value.ts'],
    expected_write_set: ['value.ts'],
    observed_write_set: ['value.ts'],
    assurance: {
      base_revision: 'b'.repeat(40),
      candidate_revision: 'c'.repeat(40),
      candidate_tree: 'd'.repeat(40),
      model_sha256: 'e'.repeat(64),
      dependency_sha256: 'f'.repeat(64),
      changed_artifacts: ['value.ts'],
      impacts: [],
      proof_plans: [],
      evidence: [],
      evidence_frontiers: [
        {
          coordinate: `revision:${'c'.repeat(40)}`,
          revision: 'c'.repeat(40),
          model_sha256: 'e'.repeat(64),
          dependency_sha256: 'f'.repeat(64),
          baseline_sha256: '1'.repeat(64),
          required_propositions: ['baseline:repository-baseline'],
          candidates: [
            {
              evidence_id: 'baseline:repository-baseline',
              proposition_ids: ['baseline:repository-baseline'],
              obligation_ids: [],
              artifact_ids: [],
              package_scripts: ['verify:repository'],
              uses_package_runtime: true,
            },
          ],
        },
      ],
      coverage_gaps: [],
      validation_mode: 'baseline',
      baseline_id: 'repository-baseline',
      baseline_sha256: '1'.repeat(64),
    },
  };
}

function context(source: SourceTransactionPlan) {
  return {
    repository_id: source.repository_id,
    repository_full_name: source.repository_full_name,
    runtime_sha: source.runtime_sha,
    verification_profile_id: source.verification_profile.profile.id,
    verification_profile_sha256: source.verification_profile.sha256,
  };
}

test('source admission consumes only exact neutral execution evidence', () => {
  const source = plan();
  const descriptor = sourceProofExecutionEvidenceDescriptor(source);
  const receipt = executionEvidenceReceipt(
    descriptor,
    sourceProofExecutionEvidenceRealization(source, 'satisfied'),
  );
  const witness = admitSourceProofEvidence(source, {
    executionEvidence: receipt,
    context: context(source),
  });
  const admitted = trustedSourceProof(witness);

  assert.equal(admitted.schema, 'overcenter-admitted-source-proof/v3');
  assert.equal(admitted.candidate_sha, source.candidate_sha);
  assert.equal(admitted.tree_sha, source.candidate_tree);
  assert.equal(admitted.execution_evidence_sha256, executionEvidenceReceiptDigest(receipt));
  assert.equal(JSON.stringify(admitted).includes('github'), false);
  assert.equal(JSON.stringify(admitted).includes('workflow'), false);
});

test('unsatisfied neutral source evidence rejects without provider semantics', () => {
  const source = plan();
  const descriptor = sourceProofExecutionEvidenceDescriptor(source);
  const receipt = executionEvidenceReceipt(
    descriptor,
    sourceProofExecutionEvidenceRealization(source, 'unsatisfied'),
  );
  assert.throws(
    () =>
      admitSourceProofEvidence(source, {
        executionEvidence: receipt,
        context: context(source),
      }),
    SourceProofRejected,
  );
});

test('source admission rejects a semantically altered receipt', () => {
  const source = plan();
  const descriptor = sourceProofExecutionEvidenceDescriptor(source);
  const receipt = executionEvidenceReceipt(
    descriptor,
    sourceProofExecutionEvidenceRealization(source, 'satisfied'),
  );
  const changed = structuredClone(receipt);
  changed.outputs.verified_tree_sha = '0'.repeat(40);

  assert.throws(
    () =>
      admitSourceProofEvidence(source, {
        executionEvidence: changed,
        context: context(source),
      }),
    /SOURCE_PROOF_EXECUTION_EVIDENCE_MISMATCH/,
  );
});

test('neutral source admission core owns no GitHub observation mechanics', () => {
  for (const path of [
    '../src/source/source-proof-admission.ts',
    '../src/source/source-proof-evidence.ts',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /GitHub|github|workflow_run|workflow_job|workflow_path|job_id|providers\/github/,
    );
  }
});
