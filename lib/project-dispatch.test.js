import test from 'node:test';
import assert from 'node:assert/strict';
import * as projectGraph from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

const { executeProjectTransitionLifecycle } = projectGraph;

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable: true, satisfied: stageIndex < index }]));
}

function completedResponsibilities() {
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, { applicable: true, satisfied: true }]));
}

function node(id, priority, executor) {
  return {
    id,
    priority,
    requires: [],
    lifecycle: { current_stage: 'ENABLE', responsibilities: responsibilitiesFor('ENABLE') },
    executor,
  };
}

test('does not expose an executor-only dispatch bypass', () => {
  assert.equal('dispatchProjectTransition' in projectGraph, false);
});

test('executes exactly the highest-value ready transition through enable acquire execute commit confirm in order', async () => {
  const calls = [];
  const agentWork = node('agent-work', 1, { kind: 'agent', role: 'debugger', skill: 'systematic-debugging' });
  const operatorWork = node('operator-work', 5, { kind: 'operator', command: 'portfolio.reconcile_work_surface' });
  const result = await executeProjectTransitionLifecycle({ nodes: [agentWork, operatorWork] }, {
    enable: async (transition) => { calls.push(['ENABLE', transition.node_id]); return { ok: true, enabled: true }; },
    acquire: async (transition) => { calls.push(['ACQUIRE', transition.node_id]); return { ok: true, lease_id: 'lease-1' }; },
    operator: async (transition) => { calls.push(['EXECUTE', transition.node_id, transition.executor.command]); return { ok: true, changed: true }; },
    agent: async (transition) => { calls.push(['EXECUTE_AGENT', transition.node_id, transition.executor.skill]); return { ok: true, changed: true }; },
    commit: async (transition) => { calls.push(['COMMIT', transition.node_id]); return { ok: true, commit_sha: 'abc123' }; },
    confirm: async (transition) => {
      calls.push(['CONFIRM', transition.node_id]);
      return {
        ok: true,
        confirmed: true,
        graph: { nodes: [
          agentWork,
          { ...operatorWork, lifecycle: { current_stage: 'CONFIRM', responsibilities: completedResponsibilities() } },
        ] },
      };
    },
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.transition.node_id, 'operator-work');
  assert.deepEqual(calls, [
    ['ENABLE', 'operator-work'],
    ['ACQUIRE', 'operator-work'],
    ['EXECUTE', 'operator-work', 'portfolio.reconcile_work_surface'],
    ['COMMIT', 'operator-work'],
    ['CONFIRM', 'operator-work'],
  ]);
  assert.equal(result.phases.CONFIRM.confirmed, true);
  assert.equal(result.confirmation.selected.state, 'DONE');
});

test('stops the lifecycle when a phase does not explicitly succeed', async () => {
  const calls = [];
  await assert.rejects(
    executeProjectTransitionLifecycle({ nodes: [node('operator-work', 5, { kind: 'operator', command: 'portfolio.reconcile_work_surface' })] }, {
      enable: async () => { calls.push('ENABLE'); return { ok: true, enabled: true }; },
      acquire: async () => { calls.push('ACQUIRE'); return { ok: false, reason: 'lease unavailable' }; },
      operator: async () => { calls.push('EXECUTE'); return { ok: true, changed: true }; },
      commit: async () => { calls.push('COMMIT'); return { ok: true, committed: true }; },
      confirm: async () => { calls.push('CONFIRM'); return { ok: true, confirmed: true }; },
    }),
    (error) => error?.code === 'PROJECT_LIFECYCLE_PHASE_INCOMPLETE' && error?.details?.phase === 'ACQUIRE',
  );
  assert.deepEqual(calls, ['ENABLE', 'ACQUIRE']);
});

test('validates the complete lifecycle handler set before starting a transition', async () => {
  const calls = [];
  await assert.rejects(
    executeProjectTransitionLifecycle({ nodes: [node('operator-work', 5, { kind: 'operator', command: 'portfolio.reconcile_work_surface' })] }, {
      enable: async () => { calls.push('ENABLE'); return { ok: true }; },
      acquire: async () => { calls.push('ACQUIRE'); return { ok: true }; },
      operator: async () => { calls.push('EXECUTE'); return { ok: true }; },
      confirm: async () => { calls.push('CONFIRM'); return { ok: true }; },
    }),
    (error) => error?.code === 'PROJECT_LIFECYCLE_HANDLER_UNAVAILABLE',
  );
  assert.equal(calls.length, 0);
});

test('confirmation proves the selected transition is done and recomputes the next frontier', async () => {
  const source = node('source-work', 5, { kind: 'operator', command: 'github.apply_changeset' });
  const dependent = { ...node('dependent-work', 1, { kind: 'operator', command: 'github.review_packet' }), requires: ['source-work'] };
  const confirmedGraph = { nodes: [
    { ...source, lifecycle: { current_stage: 'CONFIRM', responsibilities: completedResponsibilities() } },
    dependent,
  ] };

  const result = await executeProjectTransitionLifecycle({ nodes: [source, dependent] }, {
    enable: async () => ({ ok: true }),
    acquire: async () => ({ ok: true }),
    operator: async () => ({ ok: true }),
    commit: async () => ({ ok: true }),
    confirm: async () => ({ ok: true, graph: confirmedGraph }),
  });

  assert.equal(result.confirmation?.selected?.state, 'DONE');
  assert.equal(result.frontier?.length, 1);
  assert.equal(result.frontier[0].id, 'dependent-work');
});

test('returns a typed idle result when no transition is ready', async () => {
  const result = await executeProjectTransitionLifecycle({ nodes: [] }, {
    enable: async () => { throw new Error('enable should not run'); },
    acquire: async () => { throw new Error('acquire should not run'); },
    operator: async () => { throw new Error('operator should not run'); },
    agent: async () => { throw new Error('agent should not run'); },
    commit: async () => { throw new Error('commit should not run'); },
    confirm: async () => { throw new Error('confirm should not run'); },
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'PROJECT_COMPLETE');
});
