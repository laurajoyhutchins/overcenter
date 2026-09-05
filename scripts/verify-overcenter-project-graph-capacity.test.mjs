import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOvercenterProjectGraph } from '../lib/overcenter-project-graph-deriver.js';

const PROJECT_REF = 'github:example/project';
const REPOSITORY = 'example/project';
const REVISION = 'a'.repeat(40);

function retainedTransition(index) {
  return {
    id:`retained-${String(index).padStart(3, '0')}`,
    priority:1,
    requires:[],
    executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
  };
}

function derive(definition) {
  return deriveOvercenterProjectGraph({
    project_ref:PROJECT_REF,
    authority:{
      kind:'github',
      repository:REPOSITORY,
      revision:REVISION,
      derivation:'overcenter-project-graph-v1',
    },
    facts:{
      definition_facts:{
        schema:'project-definition-facts-v1',
        repository:REPOSITORY,
        revision:REVISION,
        definitions:[{
          path:'.overcenter/definitions/target-architecture.json',
          content:JSON.stringify(definition),
        }],
      },
    },
  });
}

test('Overcenter graph derivation does not impose an arbitrary total-transition ceiling', () => {
  const transitionCount = 1001;
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:PROJECT_REF,
    transitions:Array.from({ length:transitionCount }, (_, index) => retainedTransition(index + 1)),
  };

  const graph = derive(definition);
  assert.equal(graph.nodes.length, transitionCount);
});

test('Overcenter graph derivation preserves canonical repository-owned execution intent', () => {
  const executionIntent = {
    schema:'project-execution-intent-v1',
    desired_outcome:'Execute the transition from the returned packet without reconstructing task intent from prior context.',
    acceptance_evidence:[
      { kind:'verification', requirement:'Fresh exact-revision evidence demonstrates the desired outcome.' },
      { kind:'tests', requirement:'The exact final revision passes the relevant executable regression.' },
    ],
    source_ref:'github:example/project@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:.overcenter/definitions/target-architecture.json#retained-001',
  };
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:PROJECT_REF,
    transitions:[{ ...retainedTransition(1), execution_intent:executionIntent }],
  };

  const graph = derive(definition);
  assert.deepEqual(graph.nodes[0].execution_intent, {
    ...executionIntent,
    acceptance_evidence:[
      { kind:'tests', requirement:'The exact final revision passes the relevant executable regression.' },
      { kind:'verification', requirement:'Fresh exact-revision evidence demonstrates the desired outcome.' },
    ],
  });
});
