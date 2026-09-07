import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_TRANSITION_RECOVERY_SEED_PATH,
  mergeProjectTransitionObservations,
  parseProjectTransitionRecoverySeed,
  readProjectTransitionRecoverySeedWithGitHubApp,
} from '../lib/project-transition-github-recovery.js';

const seed = {
  schema:'overcenter-github-recovery-seed-v1',
  project_ref:'github:laurajoyhutchins/overcenter',
  repository:'laurajoyhutchins/overcenter',
  transition_confirmations:[{
    transition_id:'done-transition',
    transition_definition_fingerprint:'b'.repeat(64),
    source_authority_revision:'a'.repeat(40),
    settled_at:'2026-09-07T01:00:00Z',
  }],
};

function githubBody(value) {
  return { type:'file', encoding:'base64', truncated:false, content:Buffer.from(JSON.stringify(value)).toString('base64') };
}

test('recovery seed turns GitHub-owned confirmations into project observations', () => {
  const [observation] = parseProjectTransitionRecoverySeed(JSON.stringify(seed), {
    project_ref:seed.project_ref,
    repository:seed.repository,
  });
  assert.equal(observation.transition_id, 'done-transition');
  assert.equal(observation.provenance.kind, 'github_recovery_seed');
  assert.equal(observation.provenance.ref, PROJECT_TRANSITION_RECOVERY_SEED_PATH);
});

test('exact-revision GitHub read returns no observations before a seed exists', async () => {
  const result = await readProjectTransitionRecoverySeedWithGitHubApp({
    project_ref:seed.project_ref,
    repository:seed.repository,
    revision:'c'.repeat(40),
  }, {
    withGitHubAppApiClient:async (_repo, callback) => callback({ call:async () => ({ status:404 }) }),
  });
  assert.deepEqual(result, []);
});

test('exact-revision GitHub read parses the seed without database state', async () => {
  const result = await readProjectTransitionRecoverySeedWithGitHubApp({
    project_ref:seed.project_ref,
    repository:seed.repository,
    revision:'c'.repeat(40),
  }, {
    withGitHubAppApiClient:async (_repo, callback) => callback({ call:async () => ({ status:200, body:githubBody(seed) }) }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].disposition, 'completed');
});

test('database observation may refresh seed provenance without duplicating completion truth', () => {
  const [seedObservation] = parseProjectTransitionRecoverySeed(JSON.stringify(seed), { project_ref:seed.project_ref, repository:seed.repository });
  const dbObservation = {
    ...seedObservation,
    provenance:{ kind:'project_transition_settlement', lease_ref:'lease:1', settled_at:'2026-09-07T02:00:00Z' },
  };
  const result = mergeProjectTransitionObservations([seedObservation], [dbObservation]);
  assert.equal(result.length, 1);
  assert.equal(result[0].provenance.kind, 'project_transition_settlement');
});