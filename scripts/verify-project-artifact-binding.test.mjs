import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectArtifactBindingService } from '../lib/project-artifact-binding.js';

const SHA = '40e902e1eec442fb76d4a23e7c2469f4a5207f15';
const PROJECT = 'github:laurajoyhutchins/overcenter';

function service(overrides = {}) {
  const observations = [];
  const runtime = {
    readProjectGraph: async () => ({
      authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:SHA, derivation:'overcenter-project-graph-v1' } },
      nodes:[{ id:'add-project-artifact-binding' }],
    }),
    readProviderArtifact: async ({ repository, kind, number }) => ({ repository, kind, number, state:'closed' }),
    bindingRefFor: async () => 'sha256:binding',
    appendBindingObservation: async (binding) => { observations.push(binding); return { observation_ref:'portfolio_observation:1' }; },
    ...overrides,
  };
  return { binding:createProjectArtifactBindingService(runtime), observations };
}

const request = Object.freeze({
  project_ref:PROJECT,
  expected_revision:SHA,
  transition_id:'add-project-artifact-binding',
  provider:{ kind:'issue', number:732 },
  relationship:'full_coverage_equivalence',
  satisfaction_condition:'closed',
});

test('binding service revalidates exact authority and persists explicit equivalence evidence', async () => {
  const { binding, observations } = service();
  const result = await binding.bind(request);
  assert.equal(result.ok, true);
  assert.equal(result.binding.authority_revision, SHA);
  assert.equal(result.binding.relationship, 'full_coverage_equivalence');
  assert.deepEqual(result.binding.provider, { repository:'laurajoyhutchins/overcenter', kind:'issue', id:732 });
  assert.equal(result.classification.classification, 'satisfied');
  assert.equal(result.observation_ref, 'portfolio_observation:1');
  assert.equal(observations.length, 1);
});

test('stale authority fails before provider read or persistence', async () => {
  let providerReads = 0;
  let writes = 0;
  const { binding } = service({
    readProjectGraph: async () => ({ authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1111111111111111111111111111111111111111' } }, nodes:[{ id:'add-project-artifact-binding' }] }),
    readProviderArtifact: async () => { providerReads += 1; return null; },
    appendBindingObservation: async () => { writes += 1; return {}; },
  });
  await assert.rejects(binding.bind(request), (error) => error?.code === 'PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE');
  assert.equal(providerReads, 0);
  assert.equal(writes, 0);
});

test('absent semantic subject fails before provider read', async () => {
  let providerReads = 0;
  const { binding } = service({
    readProjectGraph: async () => ({ authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:SHA } }, nodes:[] }),
    readProviderArtifact: async () => { providerReads += 1; return null; },
  });
  await assert.rejects(binding.bind(request), (error) => error?.code === 'PROJECT_ARTIFACT_BINDING_SUBJECT_NOT_FOUND');
  assert.equal(providerReads, 0);
});
