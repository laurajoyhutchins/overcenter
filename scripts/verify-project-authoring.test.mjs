import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalProjectDefinition,
  applyProjectDefinitionAmendment,
} from '../lib/project-authoring.js';
import { deriveOvercenterProjectGraph } from '../lib/overcenter-project-graph-deriver.js';

const base = {
  schema: 'overcenter-project-definition-v1',
  project_ref: 'github:example/project',
  transitions: [
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};

test('canonical project authoring normalizes order without exposing runtime state', () => {
  const result = canonicalProjectDefinition({
    ...base,
    transitions: [
      { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
      base.transitions[0],
    ],
  });
  assert.deepEqual(result.transitions.map((transition) => transition.id), ['foundation', 'second']);
  assert.equal('state' in result.transitions[0], false);
  assert.equal('lifecycle' in result.transitions[0], false);
});

test('transition version impact is canonical repository-owned release intent', () => {
  const result = canonicalProjectDefinition({
    ...base,
    transitions: [{
      ...base.transitions[0],
      version_impact:{ level:'MINOR', summary:'  Add an externally visible semantic command.  ' },
    }],
  });
  assert.deepEqual(result.transitions[0].version_impact, {
    level:'minor',
    summary:'Add an externally visible semantic command.',
  });

  assert.throws(() => canonicalProjectDefinition({
    ...base,
    transitions:[{ ...base.transitions[0], version_impact:{ level:'feature', summary:'not semver' } }],
  }), /none, patch, minor, or major/);
  assert.throws(() => canonicalProjectDefinition({
    ...base,
    transitions:[{ ...base.transitions[0], version_impact:{ level:'patch' } }],
  }), /summary must be a non-empty string/);
  assert.throws(() => canonicalProjectDefinition({
    ...base,
    transitions:[{ ...base.transitions[0], version_impact:{ level:'patch', summary:'Fix behavior', version:'1.2.3' } }],
  }), /unsupported fields/);
});

test('Overcenter graph derivation validates version impact without widening execution-node state', () => {
  const revision = 'a'.repeat(40);
  const definition = canonicalProjectDefinition({
    ...base,
    transitions:[{
      ...base.transitions[0],
      version_impact:{ level:'patch', summary:'Fix public error semantics.' },
    }],
  });
  const graph = deriveOvercenterProjectGraph({
    project_ref:base.project_ref,
    authority:{
      kind:'github',
      repository:'example/project',
      revision,
      derivation:'overcenter-project-graph-v1',
    },
    facts:{
      definition_facts:{
        schema:'project-definition-facts-v1',
        repository:'example/project',
        revision,
        definitions:[{
          path:'.overcenter/definitions/target-architecture.json',
          content:JSON.stringify(definition),
        }],
      },
    },
  });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].id, 'foundation');
  assert.equal('version_impact' in graph.nodes[0], false);
});

test('semantic amendment validates the complete candidate graph', () => {
  const amended = applyProjectDefinitionAmendment(base, {
    upsert_transitions: [
      { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  });
  assert.deepEqual(amended.definition.transitions.map((transition) => transition.id), ['foundation', 'second']);
  assert.deepEqual(amended.diff.added, ['second']);
  assert.deepEqual(amended.diff.changed, []);
  assert.deepEqual(amended.diff.removed, []);

  assert.throws(() => applyProjectDefinitionAmendment(base, {
    upsert_transitions: [
      { id:'dangling', priority:1, requires:['missing'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  }), /missing dependency/);

  assert.throws(() => applyProjectDefinitionAmendment(base, {
    upsert_transitions: [
      { id:'foundation', priority:10, requires:['second'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
      { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  }), /cycle/);
});

test('confirmed transition meaning cannot be silently rewritten', () => {
  assert.throws(() => applyProjectDefinitionAmendment(base, {
    confirmed_transition_ids: ['foundation'],
    upsert_transitions: [
      { id:'foundation', priority:99, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  }), /confirmed transition/);
});

test('confirmed transition version impact cannot be silently rewritten', () => {
  const withImpact = canonicalProjectDefinition({
    ...base,
    transitions:[{ ...base.transitions[0], version_impact:{ level:'patch', summary:'Fix public behavior.' } }],
  });
  assert.throws(() => applyProjectDefinitionAmendment(withImpact, {
    confirmed_transition_ids:['foundation'],
    upsert_transitions:[{
      ...base.transitions[0],
      version_impact:{ level:'minor', summary:'Reclassify as additive behavior.' },
    }],
  }), /confirmed transition/);
});

test('project authoring runtime rejects stale authority before requesting a repository mutation', async () => {
  const runtime = await import('../lib/project-authoring-runtime.js').catch(() => null);
  assert.ok(runtime, 'project authoring runtime boundary must exist');

  let mutations = 0;
  await assert.rejects(
    () => runtime.amendProjectDefinition({
      project_ref:'github:example/project',
      expected_revision:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      amendment:{ upsert_transitions:[] },
    }, {
      resolveAuthority:async () => ({
        project_ref:'github:example/project',
        repository:'example/project',
        revision:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        derivation:'overcenter-project-graph-v1',
      }),
      readDefinition:async () => base,
      mutateDefinition:async () => { mutations += 1; return { revision:'cccccccccccccccccccccccccccccccccccccccc' }; },
      deriveProjectGraph:async () => ({ project_ref:'github:example/project' }),
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_AUTHORITY_STALE',
  );
  assert.equal(mutations, 0);
});

test('project amendment persists the validated definition then derives the graph at the resulting revision', async () => {
  const { amendProjectDefinition } = await import('../lib/project-authoring-runtime.js');
  const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const resultingRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const calls = [];

  const result = await amendProjectDefinition({
    project_ref:'github:example/project',
    expected_revision:initialRevision,
    amendment:{
      upsert_transitions:[
        { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
      ],
    },
  }, {
    resolveAuthority:async () => ({
      project_ref:'github:example/project',
      repository:'example/project',
      revision:initialRevision,
      derivation:'overcenter-project-graph-v1',
    }),
    readDefinition:async (authority) => {
      calls.push(['read', authority.revision]);
      return base;
    },
    mutateDefinition:async (request) => {
      calls.push(['mutate', request.expected_revision, request.definition.transitions.map((transition) => transition.id)]);
      return { revision:resultingRevision };
    },
    deriveProjectGraph:async (authority) => {
      calls.push(['derive', authority.revision]);
      return { schema:'overcenter-project-graph-v1', project_ref:'github:example/project', revision:authority.revision };
    },
  });

  assert.deepEqual(calls, [
    ['read', initialRevision],
    ['mutate', initialRevision, ['foundation', 'second']],
    ['derive', resultingRevision],
  ]);
  assert.equal(result.authority.revision, resultingRevision);
  assert.deepEqual(result.diff, { added:['second'], changed:[], removed:[] });
  assert.equal(result.graph.revision, resultingRevision);
});

test('project authoring rejects readback whose derived graph revision does not match the confirmed source revision', async () => {
  const { amendProjectDefinition } = await import('../lib/project-authoring-runtime.js');
  const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const resultingRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  await assert.rejects(
    () => amendProjectDefinition({
      project_ref:'github:example/project',
      expected_revision:initialRevision,
      amendment:{ upsert_transitions:[] },
    }, {
      resolveAuthority:async () => ({
        project_ref:'github:example/project',
        repository:'example/project',
        revision:initialRevision,
        derivation:'overcenter-project-graph-v1',
      }),
      readDefinition:async () => base,
      mutateDefinition:async () => ({ revision:resultingRevision }),
      deriveProjectGraph:async () => ({
        schema:'overcenter-project-graph-v1',
        project_ref:'github:example/project',
        revision:'cccccccccccccccccccccccccccccccccccccccc',
      }),
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_READBACK_MISMATCH',
  );
});

test('project amendment protects authoritative confirmed history even when caller omits confirmation hints', async () => {
  const { amendProjectDefinition } = await import('../lib/project-authoring-runtime.js');
  const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let mutations = 0;

  await assert.rejects(
    () => amendProjectDefinition({
      project_ref:'github:example/project',
      expected_revision:initialRevision,
      amendment:{ remove_transition_ids:['foundation'] },
    }, {
      resolveAuthority:async () => ({
        project_ref:'github:example/project',
        repository:'example/project',
        revision:initialRevision,
        derivation:'overcenter-project-graph-v1',
      }),
      readDefinition:async () => base,
      readProjectObservations:async () => ([{
        schema:'project-transition-observation-v1',
        kind:'project_transition_confirmation',
        project_ref:'github:example/project',
        transition_id:'foundation',
        disposition:'completed',
      }]),
      mutateDefinition:async () => { mutations += 1; return { revision:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }; },
      deriveProjectGraph:async () => ({ schema:'overcenter-project-graph-v1', project_ref:'github:example/project', revision:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    }),
    /confirmed transition/,
  );
  assert.equal(mutations, 0);
});
