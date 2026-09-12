import test from 'node:test';
import assert from 'node:assert/strict';
import { executeProjectTransitionLifecycle } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable: true, satisfied: stageIndex < index }]));
}

function node(id, priority, requires = []) {
  return {
    id,
    priority,
    requires,
    lifecycle: { current_stage: 'EXECUTE', responsibilities: responsibilitiesFor('EXECUTE') },
    executor: { kind: 'operator', command: 'github.apply_changeset' },
  };
}

test('execution commits and confirms a discovered prerequisite before exposing the replanned frontier', async () => {
  const calls = [];
  const selected = node('implement-runtime', 10);
  const prerequisite = node('establish-schema', 20);
  const replannedSelected = node('implement-runtime', 10, ['establish-schema']);
  const authoritativeReplannedGraph = { nodes: [prerequisite, replannedSelected] };
  const result = await executeProjectTransitionLifecycle({ nodes: [selected] }, {
    enable: async () => { calls.push('ENABLE'); return { ok: true }; },
    acquire: async () => { calls.push('ACQUIRE'); return { ok: true }; },
    operator: async () => {
      calls.push('EXECUTE');
      return {
        ok: true,
        replan: {
          graph: { nodes: [selected] },
          amendment: { upsert_nodes: [prerequisite, replannedSelected] },
        },
      };
    },
    commit: async (_transition, context) => {
      calls.push('COMMIT');
      assert.ok(context?.phases?.EXECUTE?.replan, 'commit did not receive the execute-time graph amendment');
      return { ok: true };
    },
    confirm: async () => {
      calls.push('CONFIRM');
      return { ok: true, graph: authoritativeReplannedGraph };
    },
  });

  assert.equal(result.replanned, true);
  assert.equal(result.reason, 'PROJECT_GRAPH_REPLANNED');
  assert.deepEqual(calls, ['EXECUTE', 'COMMIT', 'CONFIRM']);
  assert.equal(result.frontier?.length, 1);
  assert.equal(result.frontier[0].id, 'establish-schema');
  const blocked = result.evaluation?.nodes?.find((entry) => entry.id === 'implement-runtime');
  assert.equal(blocked?.state, 'WAITING');
  assert.equal(blocked?.unmet_requirements?.[0], 'establish-schema');
});

test('rejects confirmation that does not contain the committed graph amendment', async () => {
  const selected = node('implement-runtime', 10);
  const prerequisite = node('establish-schema', 20);
  const replannedSelected = node('implement-runtime', 10, ['establish-schema']);
  const differentPrerequisite = node('different-prereq', 30);
  const differentlyBlockedSelected = node('implement-runtime', 10, ['different-prereq']);

  await assert.rejects(
    executeProjectTransitionLifecycle({ nodes: [selected] }, {
      operator: async () => ({
        ok: true,
        replan: {
          graph: { nodes: [selected] },
          amendment: { upsert_nodes: [prerequisite, replannedSelected] },
        },
      }),
      commit: async () => ({ ok: true }),
      confirm: async () => ({
        ok: true,
        graph: { nodes: [differentPrerequisite, differentlyBlockedSelected] },
      }),
    }),
    (error) => error?.code === 'PROJECT_REPLAN_CONFIRMATION_MISMATCH',
  );
});
