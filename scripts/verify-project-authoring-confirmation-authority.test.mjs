import test from 'node:test';
import assert from 'node:assert/strict';
import { amendProjectDefinition } from '../lib/project-authoring-runtime.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const base = {
  schema:'overcenter-project-definition-v1',
  project_ref:'github:example/project',
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};

test('project amendment protects authoritative confirmed history even when caller omits confirmation hints', async () => {
  let mutations = 0;
  await assert.rejects(
    () => amendProjectDefinition({
      project_ref:'github:example/project',
      expected_revision:initialRevision,
      amendment:{ remove_transition_ids:['foundation'] },
    }, {
      resolveAuthority:async () => ({
        kind:'github',
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
