import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reconstructProjectArtifactLineage,
  classifyProjectArtifactLineage,
} from '../lib/project-artifact-lineage.js';

const SHA = '94587c05ff813795bd2c8832af72d5c0dda18cec';
const CANDIDATE = 'f345460c61185bec1f1808d45076ba68666d7cee';

function durableFacts(overrides = {}) {
  return {
    project_ref: 'github:laurajoyhutchins/overcenter',
    transition_id: 'establish-project-artifact-lineage',
    semantic_operation: 'github.integration.reconcile',
    idempotency_identity: 'cf53be74-d22a-4fc2-8564-86b799056b24',
    repository: 'laurajoyhutchins/overcenter',
    authority_revision: SHA,
    candidate: { head: CANDIDATE, base: SHA },
    provider: { kind: 'pull_request', id: 591, state: 'merged', head: CANDIDATE, base: SHA },
    integration: { outcome: 'merged', merge_commit_sha: SHA, expected_head: CANDIDATE },
    settlement: { disposition: 'completed', evidence_refs: [{ kind: 'pull_request', ref: 'github:laurajoyhutchins/overcenter#591' }] },
    ...overrides,
  };
}

test('reconstructs exact artifact lineage from durable machine facts without prose', () => {
  const lineage = reconstructProjectArtifactLineage(durableFacts());
  assert.equal(lineage.project_ref, 'github:laurajoyhutchins/overcenter');
  assert.equal(lineage.transition_id, 'establish-project-artifact-lineage');
  assert.equal(lineage.semantic_operation, 'github.integration.reconcile');
  assert.equal(lineage.idempotency_identity, 'cf53be74-d22a-4fc2-8564-86b799056b24');
  assert.deepEqual(lineage.provider, { repository: 'laurajoyhutchins/overcenter', kind: 'pull_request', id: 591 });
  assert.deepEqual(lineage.candidate, { head: CANDIDATE, base: SHA, authority_revision: SHA });
  assert.equal(lineage.integration.merge_commit_sha, SHA);
  assert.equal(lineage.settlement.disposition, 'completed');
  assert.equal(lineage.provenance, 'durable-facts');
});

test('classifies exact merged candidate as satisfied and newer exact candidate as superseding older artifact', () => {
  const current = reconstructProjectArtifactLineage(durableFacts());
  assert.equal(classifyProjectArtifactLineage(current).classification, 'satisfied');

  const older = reconstructProjectArtifactLineage(durableFacts({
    candidate: { head: '10350107c186c3d6c837870af53aa7526a9a8ee1', base: SHA },
    provider: { kind: 'pull_request', id: 590, state: 'open', head: '10350107c186c3d6c837870af53aa7526a9a8ee1', base: SHA },
    integration: null,
    settlement: null,
  }));
  const superseded = classifyProjectArtifactLineage(older, { newer_lineage: current });
  assert.equal(superseded.classification, 'superseded');
  assert.equal(superseded.evidence.newer_provider_id, 591);
});

test('fails closed on ambiguous ownership, candidate identity drift, and prose-only relationships', () => {
  assert.throws(() => reconstructProjectArtifactLineage(durableFacts({ transition_id: null })), /transition identity/);
  assert.throws(() => reconstructProjectArtifactLineage(durableFacts({
    provider: { kind: 'pull_request', id: 591, state: 'open', head: SHA, base: SHA },
  })), /candidate head/);
  assert.throws(() => reconstructProjectArtifactLineage({
    repository: 'laurajoyhutchins/overcenter',
    provider: { kind: 'issue', id: 420, state: 'open' },
    title: 'Looks related to lineage',
    body: 'Chat says this belongs to the transition.',
  }), /project_ref/);
});

test('orphaning requires exact Overcenter ownership and absence of live continuation', () => {
  const candidate = reconstructProjectArtifactLineage(durableFacts({ integration: null, settlement: null }));
  assert.equal(classifyProjectArtifactLineage(candidate, {
    current_project_transition_ids: [],
    live_execution_provider_ids: [],
    overcenter_owned_provider_ids: [591],
  }).classification, 'orphaned');

  assert.equal(classifyProjectArtifactLineage(candidate, {
    current_project_transition_ids: [],
    live_execution_provider_ids: [591],
    overcenter_owned_provider_ids: [591],
  }).classification, 'active');

  assert.equal(classifyProjectArtifactLineage(candidate, {
    current_project_transition_ids: [],
    live_execution_provider_ids: [],
    overcenter_owned_provider_ids: [],
  }).classification, 'ambiguous');
});