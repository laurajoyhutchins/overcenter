import { applyProjectGraphAmendment, evaluateProjectGraph } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }
function responsibilitiesFor(target, complete = false) {
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, index) => [stage, {
    applicable:true,
    satisfied:complete || index < PRODUCTIVE_STAGES.indexOf(target),
  }]));
}
function lifecycle(target = 'ENABLE', complete = false) {
  return { current_stage:target, responsibilities:responsibilitiesFor(target, complete) };
}
function operatorNode(id, priority = 0, requires = [], complete = false) {
  return { id, priority, requires, lifecycle:lifecycle('ENABLE', complete), executor:{ kind:'operator', command:`operator.${id}` } };
}

export async function runProjectGraphAmendmentTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('atomically amends nodes and recomputes the enabled frontier', async () => {
    const base = { nodes:[
      operatorNode('obsolete-prerequisite', 1, [], true),
      operatorNode('target', 2, ['obsolete-prerequisite']),
    ] };
    const result = applyProjectGraphAmendment(base, {
      remove_node_ids:['obsolete-prerequisite'],
      upsert_nodes:[
        operatorNode('replacement-prerequisite', 5, [], true),
        operatorNode('target', 9, ['replacement-prerequisite']),
      ],
    });

    assert(JSON.stringify(result.graph.nodes.map((node) => node.id)) === JSON.stringify(['replacement-prerequisite','target']), 'amended graph was not canonicalized');
    assert(result.evaluation.frontier.length === 1, 'amended graph did not derive one ready transition');
    assert(result.evaluation.frontier[0].id === 'target', 'frontier was not recomputed from amended dependencies');
    assert(result.evaluation.frontier[0].priority === 9, 'replacement node state was not used');
  });

  await test('fails closed when removal would leave a dangling dependency', async () => {
    const base = { nodes:[operatorNode('source', 1, [], true), operatorNode('target', 2, ['source'])] };
    let error = null;
    try { applyProjectGraphAmendment(base, { remove_node_ids:['source'] }); }
    catch (caught) { error = caught; }
    assert(error?.code === 'INVALID_PROJECT_GRAPH', 'dangling dependency did not fail closed');
    const unchanged = evaluateProjectGraph(base);
    assert(unchanged.nodes.length === 2 && unchanged.frontier[0]?.id === 'target', 'failed amendment mutated the input graph');
  });

  await test('rejects contradictory remove and upsert operations for one node', async () => {
    const base = { nodes:[operatorNode('target')] };
    let error = null;
    try { applyProjectGraphAmendment(base, { remove_node_ids:['target'], upsert_nodes:[operatorNode('target', 10)] }); }
    catch (caught) { error = caught; }
    assert(error?.code === 'INVALID_PROJECT_GRAPH_AMENDMENT', 'contradictory amendment was accepted');
  });

  return { ok:tests.every((entry) => entry.ok), passed:tests.filter((entry) => entry.ok).length, failed:tests.filter((entry) => !entry.ok).length, tests };
}
