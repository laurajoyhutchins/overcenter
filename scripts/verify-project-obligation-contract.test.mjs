import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_OBLIGATION_GRAPH_CONTRACT,
  PROJECT_OBLIGATION_GRAPH_PROFILE,
  assertExactObligationAuthorityCoordinate,
  assertPredecessorClosedObligationSet,
  projectObligationFingerprint,
  projectObligationGraphFingerprint,
  projectObligationGraphSemanticInput,
  projectObligationSemanticInput,
} from '../lib/project-obligation-contract.js';
import { deriveProjectObligationProjection } from '../lib/project-obligation-state.js';
import { evaluateProjectGraph } from '../lib/project-graph.js';

const transition = (overrides = {}) => ({
  id:'B',
  priority:42,
  requires:['A'],
  executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
  version_impact:{ kind:'patch' },
  phase_bindings:{ CONFIRM:{ primitive:'verify.transition', evidence:['result'] } },
  lifecycle:{ current_stage:'EXECUTE', condition:'NOMINAL' },
  state:'READY',
  unmet_requirements:[],
  lease_ref:'lease-1',
  run_id:'run-1',
  evidence:[{ kind:'commit', ref:'abc' }],
  observed_at:'2026-09-05T05:00:00Z',
  ...overrides,
});

const obligationAuthority = (revision = 'a'.repeat(40)) => ({
  kind:'github',
  repository:'owner/repo',
  revision,
  derivation:'overcenter-project-graph-v1',
});

const lifecycle = ({ complete = false, condition = 'NOMINAL' } = {}) => ({
  current_stage:'CONFIRM',
  condition,
  responsibilities:Object.freeze(Object.fromEntries(
    ['ENABLE', 'ACQUIRE', 'EXECUTE', 'COMMIT', 'CONFIRM'].map((stage) => [
      stage,
      Object.freeze({ applicable:true, satisfied:complete }),
    ]),
  )),
});

test('obligation graph profile preserves finite acyclic all-of semantics', () => {
  assert.equal(PROJECT_OBLIGATION_GRAPH_PROFILE, 'overcenter-obligation-dag-v1');
  assert.deepEqual(PROJECT_OBLIGATION_GRAPH_CONTRACT.workflow, {
    dependency_semantics:'all',
    acyclic:true,
    transition_fires_at_most_once:true,
    token_accounting:false,
  });
});

test('obligation semantic input separates logical key and runtime state from semantic content', () => {
  const input = projectObligationSemanticInput(transition());
  assert.deepEqual(input, {
    schema:'project-obligation-semantics-v1',
    requires:['A'],
    executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
    version_impact:{ kind:'patch' },
    phase_bindings:{ CONFIRM:{ primitive:'verify.transition', evidence:['result'] } },
  });
  assert.equal(Object.hasOwn(input, 'id'), false);
  assert.equal(Object.hasOwn(input, 'priority'), false);
  assert.equal(Object.hasOwn(input, 'lifecycle'), false);
  assert.equal(Object.hasOwn(input, 'lease_ref'), false);
  assert.equal(Object.hasOwn(input, 'evidence'), false);
});

test('graph semantic input is stable across transition and dependency ordering', () => {
  const left = projectObligationGraphSemanticInput({
    project_ref:'github:owner/repo',
    authority:{ revision:'a'.repeat(40) },
    transitions:[
      transition({ id:'C', priority:1, requires:['B', 'A'] }),
      transition({ id:'A', priority:99, requires:[] }),
      transition({ id:'B', priority:42, requires:['A'] }),
    ],
  });
  const right = projectObligationGraphSemanticInput({
    project_ref:'github:different/repo',
    authority:{ revision:'b'.repeat(40) },
    transitions:[
      transition({ id:'B', priority:-10, requires:['A'] }),
      transition({ id:'C', priority:500, requires:['A', 'B'] }),
      transition({ id:'A', priority:0, requires:[] }),
    ],
  });
  assert.deepEqual(left, right);
  assert.deepEqual(left.transitions.map((item) => item.key), ['A', 'B', 'C']);
});

test('satisfied obligations must be predecessor closed', () => {
  const transitions = [
    transition({ id:'A', requires:[] }),
    transition({ id:'B', requires:['A'] }),
    transition({ id:'C', requires:['B'] }),
  ];
  assert.deepEqual(assertPredecessorClosedObligationSet(transitions, ['A', 'B']), ['A', 'B']);
  assert.throws(
    () => assertPredecessorClosedObligationSet(transitions, ['B']),
    (error) => error?.code === 'PROJECT_OBLIGATION_PREDECESSOR_CLOSURE_INVALID'
      && error?.details?.transition_id === 'B'
      && error?.details?.missing_requirement === 'A',
  );
});

test('historical obligation claims require exact authority provenance', () => {
  assert.deepEqual(assertExactObligationAuthorityCoordinate({
    kind:'github',
    repository:'owner/repo',
    revision:'A'.repeat(40),
    derivation:'overcenter-project-graph-v1',
  }), {
    kind:'github',
    repository:'owner/repo',
    revision:'a'.repeat(40),
    derivation:'overcenter-project-graph-v1',
  });
  assert.throws(
    () => assertExactObligationAuthorityCoordinate({
      kind:'github', repository:'owner/repo', revision:'abc123', derivation:'overcenter-project-graph-v1',
    }),
    (error) => error?.code === 'PROJECT_OBLIGATION_AUTHORITY_INVALID',
  );
});

test('obligation fingerprint ignores logical key, priority, and mutable runtime representation', async () => {
  const baseline = await projectObligationFingerprint(transition());
  const representationallyDifferent = await projectObligationFingerprint(transition({
    id:'renamed-logical-key',
    priority:-999,
    lifecycle:{ current_stage:'CONFIRM', condition:'NOMINAL' },
    state:'DONE',
    unmet_requirements:['runtime-noise'],
    lease_ref:'lease-2',
    run_id:'run-2',
    evidence:[{ kind:'receipt', ref:'different' }],
    observed_at:'2026-09-05T06:00:00Z',
  }));
  assert.equal(representationallyDifferent, baseline);
});

test('obligation fingerprint changes when execution or acceptance semantics change', async () => {
  const baseline = await projectObligationFingerprint(transition());
  assert.notEqual(await projectObligationFingerprint(transition({
    executor:{ kind:'agent', role:'verification', skill:'test-driven-development' },
  })), baseline);
  assert.notEqual(await projectObligationFingerprint(transition({
    version_impact:{ kind:'minor' },
  })), baseline);
  assert.notEqual(await projectObligationFingerprint(transition({
    phase_bindings:{ CONFIRM:{ primitive:'verify.transition', evidence:['result', 'receipt'] } },
  })), baseline);
});

test('dependency changes invalidate obligation and graph fingerprints', async () => {
  const baselineObligation = await projectObligationFingerprint(transition({ requires:['A'] }));
  const changedObligation = await projectObligationFingerprint(transition({ requires:['A', 'C'] }));
  assert.notEqual(changedObligation, baselineObligation);

  const baselineGraph = await projectObligationGraphFingerprint({
    transitions:[
      transition({ id:'A', requires:[] }),
      transition({ id:'B', requires:['A'] }),
      transition({ id:'C', requires:[] }),
    ],
  });
  const changedGraph = await projectObligationGraphFingerprint({
    transitions:[
      transition({ id:'A', requires:[] }),
      transition({ id:'B', requires:['A', 'C'] }),
      transition({ id:'C', requires:[] }),
    ],
  });
  assert.notEqual(changedGraph, baselineGraph);
});

test('graph fingerprint is stable across ordering, formatting noise, priority, and Git authority revision', async () => {
  const left = await projectObligationGraphFingerprint({
    project_ref:'github:owner/repo',
    authority:{ kind:'github', repository:'owner/repo', revision:'a'.repeat(40), derivation:'overcenter-project-graph-v1' },
    transitions:[
      transition({ id:'C', priority:1, requires:['B', 'A'] }),
      transition({ id:'A', priority:99, requires:[] }),
      transition({ id:'B', priority:42, requires:['A'] }),
    ],
  });
  const right = await projectObligationGraphFingerprint({
    project_ref:'github:owner/repo',
    authority:{ kind:'github', repository:'owner/repo', revision:'b'.repeat(40), derivation:'overcenter-project-graph-v1' },
    transitions:[
      transition({ id:'B', priority:-10, requires:['A'], state:'DONE' }),
      transition({ id:'C', priority:500, requires:['A', 'B'], run_id:'different-run' }),
      transition({ id:'A', priority:0, requires:[], evidence:[{ kind:'different' }] }),
    ],
  });
  assert.equal(right, left);
});

test('graph fingerprint retains logical obligation keys even though individual fingerprints do not', async () => {
  const left = await projectObligationGraphFingerprint({
    transitions:[transition({ id:'A', requires:[] })],
  });
  const right = await projectObligationGraphFingerprint({
    transitions:[transition({ id:'renamed', requires:[] })],
  });
  assert.notEqual(right, left);
});

test('derived readiness follows predecessor-closed historical satisfaction', async () => {
  const a = transition({ id:'A', requires:[] });
  const b = transition({ id:'B', requires:['A'] });
  const aFingerprint = await projectObligationFingerprint(a);
  const result = await deriveProjectObligationProjection({
    nodes:[b, a],
    authority:obligationAuthority(),
    realizations:[{
      transition_id:'A',
      obligation_fingerprint:aFingerprint,
      authority:obligationAuthority('b'.repeat(40)),
      disposition:'completed',
    }],
  });
  assert.deepEqual(result.nodes.map((node) => [node.id, node.state, node.unmet_requirements]), [
    ['A', 'DONE', []],
    ['B', 'READY', []],
  ]);
  assert.deepEqual(result.frontier.map((node) => node.id), ['B']);
});

test('changed obligation identity makes historical realization stale instead of done', async () => {
  const previous = transition({ id:'A', requires:[] });
  const changed = transition({
    id:'A',
    requires:[],
    executor:{ kind:'agent', role:'verification', skill:'test-driven-development' },
  });
  const previousFingerprint = await projectObligationFingerprint(previous);
  const result = await deriveProjectObligationProjection({
    nodes:[changed],
    authority:obligationAuthority(),
    realizations:[{
      transition_id:'A',
      obligation_fingerprint:previousFingerprint,
      authority:obligationAuthority('b'.repeat(40)),
      disposition:'completed',
    }],
  });
  assert.equal(result.nodes[0].state, 'READY');
  assert.equal(result.accepted_realizations.length, 0);
  assert.equal(result.stale_realizations[0].reason, 'obligation_identity_changed');
});

test('derived satisfaction fails closed when historical completion is not predecessor closed', async () => {
  const a = transition({ id:'A', requires:[] });
  const b = transition({ id:'B', requires:['A'] });
  const bFingerprint = await projectObligationFingerprint(b);
  await assert.rejects(
    () => deriveProjectObligationProjection({
      nodes:[a, b],
      authority:obligationAuthority(),
      realizations:[{
        transition_id:'B',
        obligation_fingerprint:bFingerprint,
        authority:obligationAuthority(),
        disposition:'completed',
      }],
    }),
    (error) => error?.code === 'PROJECT_OBLIGATION_PREDECESSOR_CLOSURE_INVALID',
  );
});

test('empty derived frontier is explainable by live execution or an explicit blocker', async () => {
  const a = transition({ id:'A', requires:[] });
  const aFingerprint = await projectObligationFingerprint(a);
  const executing = await deriveProjectObligationProjection({
    nodes:[a],
    authority:obligationAuthority(),
    executions:[{
      transition_id:'A',
      obligation_fingerprint:aFingerprint,
      authority:obligationAuthority(),
      lease_ref:'lease-1',
    }],
  });
  assert.equal(executing.frontier.length, 0);
  assert.equal(executing.nodes[0].state, 'EXECUTING');

  const blocked = await deriveProjectObligationProjection({
    nodes:[a],
    authority:obligationAuthority(),
    blockers:[{
      transition_id:'A',
      obligation_fingerprint:aFingerprint,
      reason:'needs-owner-decision',
    }],
  });
  assert.equal(blocked.frontier.length, 0);
  assert.equal(blocked.nodes[0].state, 'OFF_NOMINAL');
});

test('legacy graph evaluator rejects impossible DONE history and allows explainable empty frontier', () => {
  const executor = { kind:'agent', role:'implementation', skill:'test-driven-development' };
  assert.throws(
    () => evaluateProjectGraph({ nodes:[
      { id:'A', priority:1, requires:[], executor, phase_bindings:{}, lifecycle:lifecycle({ complete:false }) },
      { id:'B', priority:0, requires:['A'], executor, phase_bindings:{}, lifecycle:lifecycle({ complete:true }) },
    ] }),
    (error) => error?.code === 'PROJECT_OBLIGATION_PREDECESSOR_CLOSURE_INVALID',
  );

  const blocked = evaluateProjectGraph({ nodes:[
    { id:'A', priority:1, requires:[], executor, phase_bindings:{}, lifecycle:lifecycle({ condition:'HOLD' }) },
    { id:'B', priority:0, requires:['A'], executor, phase_bindings:{}, lifecycle:lifecycle() },
  ] });
  assert.equal(blocked.complete, false);
  assert.equal(blocked.frontier.length, 0);
  assert.deepEqual(blocked.nodes.map((node) => [node.id, node.state]), [
    ['A', 'OFF_NOMINAL'],
    ['B', 'WAITING'],
  ]);
});