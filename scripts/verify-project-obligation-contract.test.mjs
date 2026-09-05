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