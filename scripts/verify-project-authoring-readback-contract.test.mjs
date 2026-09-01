import test from 'node:test';
import assert from 'node:assert/strict';
import { amendProjectDefinition } from '../lib/project-authoring-runtime.js';

const initialRevision = 'a'.repeat(40);
const stagedRevision = 'b'.repeat(40);
const authoritativeRevision = 'c'.repeat(40);
const projectRef = 'github:example/project';
const baseDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};
const amendedDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    { id:'verify', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'verification', skill:'verification-before-completion' } },
  ],
};
const amendment = {
  upsert_transitions:[
    { id:'verify', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'verification', skill:'verification-before-completion' } },
  ],
};

function authority(revision) {
  return {
    project_ref:projectRef,
    kind:'github',
    repository:'example/project',
    revision,
    derivation:'overcenter-project-graph-v1',
  };
}

function dependencies(overrides = {}) {
  return {
    resolveAuthority:async () => authority(initialRevision),
    readDefinition:async () => baseDefinition,
    mutateDefinition:async () => ({ revision:stagedRevision }),
    deriveProjectGraph:async (observedAuthority) => ({ nodes:[], horizons:[], revision:observedAuthority.revision }),
    ...overrides,
  };
}

test('authoring success comes from a fresh authoritative readback rather than the staged mutation revision', async () => {
  let authorityReads = 0;
  let derivedAt = null;
  const result = await amendProjectDefinition({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment,
  }, dependencies({
    resolveAuthority:async () => authority(++authorityReads === 1 ? initialRevision : authoritativeRevision),
    readDefinition:async (observedAuthority) => observedAuthority.revision === initialRevision ? baseDefinition : amendedDefinition,
    deriveProjectGraph:async (observedAuthority) => {
      derivedAt = observedAuthority.revision;
      return { nodes:[], horizons:[], revision:observedAuthority.revision };
    },
  }));

  assert.equal(authorityReads, 2);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.equal(result.graph.revision, authoritativeRevision);
  assert.equal(derivedAt, authoritativeRevision);
});

test('authoring rejects a staged mutation that is not observable through refreshed authority', async () => {
  let authorityReads = 0;
  await assert.rejects(
    () => amendProjectDefinition({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment,
    }, dependencies({
      resolveAuthority:async () => {
        authorityReads += 1;
        return authority(initialRevision);
      },
    })),
    (error) => error?.code === 'PROJECT_AUTHORING_READBACK_MISMATCH'
      && error?.may_have_mutated === true
      && error?.details?.may_have_mutated === true
      && error?.details?.staged_revision === stagedRevision
      && error?.details?.observed_authority_revision === initialRevision,
  );
  assert.equal(authorityReads, 2);
});

test('post-mutation authoritative derivation failure preserves mutation uncertainty at the boundary', async () => {
  let authorityReads = 0;
  await assert.rejects(
    () => amendProjectDefinition({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment,
    }, dependencies({
      resolveAuthority:async () => authority(++authorityReads === 1 ? initialRevision : authoritativeRevision),
      readDefinition:async (observedAuthority) => observedAuthority.revision === initialRevision ? baseDefinition : amendedDefinition,
      deriveProjectGraph:async () => {
        const error = new Error('readback unavailable after confirmed authoritative observation');
        error.code = 'PROJECT_GRAPH_READBACK_UNAVAILABLE';
        throw error;
      },
    })),
    (error) => error?.may_have_mutated === true && error?.details?.may_have_mutated === true,
  );
  assert.equal(authorityReads, 2);
});
