import test from 'node:test';
import assert from 'node:assert/strict';
import { amendProjectDefinition } from '../lib/project-authoring-runtime.js';

const initialRevision = 'a'.repeat(40);
const resultingRevision = 'b'.repeat(40);
const projectRef = 'github:example/project';
const baseDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};
const amendment = {
  upsert_transitions:[
    { id:'verify', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'verification', skill:'verification-before-completion' } },
  ],
};

function dependencies(overrides = {}) {
  return {
    resolveAuthority:async () => ({
      project_ref:projectRef,
      kind:'github',
      repository:'example/project',
      revision:initialRevision,
      derivation:'overcenter-project-graph-v1',
    }),
    readDefinition:async () => baseDefinition,
    mutateDefinition:async () => ({ revision:resultingRevision }),
    deriveProjectGraph:async () => ({ nodes:[], horizons:[] }),
    ...overrides,
  };
}

test('authoring attributes a revisionless canonical graph to the confirmed resulting authority', async () => {
  const result = await amendProjectDefinition({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment,
  }, dependencies());

  assert.equal(result.authority.revision, resultingRevision);
  assert.equal(result.graph.revision, resultingRevision);
  assert.deepEqual(result.graph.nodes, []);
  assert.deepEqual(result.graph.horizons, []);
});

test('post-mutation readback failure preserves mutation uncertainty at the boundary', async () => {
  await assert.rejects(
    () => amendProjectDefinition({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment,
    }, dependencies({
      deriveProjectGraph:async () => {
        const error = new Error('readback unavailable after confirmed mutation');
        error.code = 'PROJECT_GRAPH_READBACK_UNAVAILABLE';
        throw error;
      },
    })),
    (error) => error?.may_have_mutated === true && error?.details?.may_have_mutated === true,
  );
});
