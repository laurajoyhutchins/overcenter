import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectArtifactBindingService, classifyProjectArtifactBinding } from '../lib/project-artifact-binding.js';

const REV = '492716fe9d3d43e6dfca2566b94c8329255727b8';
const PROJECT = 'github:laurajoyhutchins/overcenter';

function graph() {
  return { project_ref:PROJECT, authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:REV } }, nodes:[{ id:'target-obligation' }] };
}

test('explicit issue binding is exact, durable, and mechanically satisfiable', async () => {
  const writes = [];
  const service = createProjectArtifactBindingService({
    readProjectGraph:async () => graph(),
    readProviderArtifact:async () => ({ repository:'laurajoyhutchins/overcenter', kind:'issue', number:42, state:'closed', merged:false }),
    appendBindingObservation:async (binding) => { writes.push(binding); return { observation_ref:'binding:1' }; },
  });
  const result = await service.bind({ project_ref:PROJECT, expected_revision:REV, transition_id:'target-obligation', provider:{ kind:'issue', number:42 }, relationship:'full_coverage_equivalence', satisfaction_condition:'closed' });
  assert.equal(result.binding.provider.number, 42);
  assert.equal(result.binding.relationship, 'full_coverage_equivalence');
  assert.equal(writes.length, 1);
  assert.equal(classifyProjectArtifactBinding(result.binding, { repository:'laurajoyhutchins/overcenter', kind:'issue', number:42, state:'closed', merged:false }).classification, 'satisfied');
});

test('unbound lookalike remains ambiguous even when closed', () => {
  const provider = { repository:'laurajoyhutchins/overcenter', kind:'issue', number:43, state:'closed', merged:false };
  assert.deepEqual(classifyProjectArtifactBinding(null, provider), { classification:'ambiguous', reason:'explicit-binding-required' });
});

test('binding fails closed on authority drift before durable mutation', async () => {
  let writes = 0;
  const service = createProjectArtifactBindingService({
    readProjectGraph:async () => ({ ...graph(), authority:{ definition:{ ...graph().authority.definition, revision:'1111111111111111111111111111111111111111' } } }),
    readProviderArtifact:async () => { throw new Error('must not read provider after drift'); },
    appendBindingObservation:async () => { writes += 1; },
  });
  await assert.rejects(() => service.bind({ project_ref:PROJECT, expected_revision:REV, transition_id:'target-obligation', provider:{ kind:'issue', number:42 }, relationship:'full_coverage_equivalence', satisfaction_condition:'closed' }), (error) => error.code === 'PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE');
  assert.equal(writes, 0);
});
