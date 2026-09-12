import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProjectGraphAmendment, evaluateProjectGraph } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function responsibilitiesFor(target, complete = false) {
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, index) => [stage, {
    applicable: true,
    satisfied: complete || index < PRODUCTIVE_STAGES.indexOf(target),
  }]));
}

function lifecycle(target = 'ENABLE', complete = false) {
  return { current_stage: target, responsibilities: responsibilitiesFor(target, complete) };
}

function operatorNode(id, priority = 0, requires = [], complete = false) {
  return { id, priority, requires, lifecycle: lifecycle('ENABLE', complete), executor: { kind: 'operator', command: 'github.review_packet' } };
}

test('atomically amends nodes and recomputes the enabled frontier', () => {
  const base = { nodes: [
    operatorNode('obsolete-prerequisite', 1, [], true),
    operatorNode('target', 2, ['obsolete-prerequisite']),
  ] };
  const result = applyProjectGraphAmendment(base, {
    remove_node_ids: ['obsolete-prerequisite'],
    upsert_nodes: [
      operatorNode('replacement-prerequisite', 5, [], true),
      operatorNode('target', 9, ['replacement-prerequisite']),
    ],
  });

  assert.deepEqual(result.graph.nodes.map((node) => node.id), ['replacement-prerequisite', 'target']);
  assert.equal(result.evaluation.frontier.length, 1);
  assert.equal(result.evaluation.frontier[0].id, 'target');
  assert.equal(result.evaluation.frontier[0].priority, 9);
});

test('fails closed when removal would leave a dangling dependency', () => {
  const base = { nodes: [operatorNode('source', 1, [], true), operatorNode('target', 2, ['source'])] };
  assert.throws(
    () => applyProjectGraphAmendment(base, { remove_node_ids: ['source'] }),
    (error) => error?.code === 'INVALID_PROJECT_GRAPH',
  );
  const unchanged = evaluateProjectGraph(base);
  assert.equal(unchanged.nodes.length, 2);
  assert.equal(unchanged.frontier[0]?.id, 'target');
});

test('rejects contradictory remove and upsert operations for one node', () => {
  const base = { nodes: [operatorNode('target')] };
  assert.throws(
    () => applyProjectGraphAmendment(base, { remove_node_ids: ['target'], upsert_nodes: [operatorNode('target', 10)] }),
    (error) => error?.code === 'INVALID_PROJECT_GRAPH_AMENDMENT',
  );
});
