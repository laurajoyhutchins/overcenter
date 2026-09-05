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

test('Overcenter graph derivation accepts more than 100 retained transitions', () => {
  const definition = {
    schema:'overcenter-project-definition-v1',
    project_ref:PROJECT_REF,
    transitions:Array.from({ length:107 }, (_, index) => retainedTransition(index + 1)),
  };

  const graph = deriveOvercenterProjectGraph({
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

  assert.equal(graph.nodes.length, 107);
});
