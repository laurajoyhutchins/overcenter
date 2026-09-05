import assert from 'node:assert/strict';
import test from 'node:test';

async function loadContract() {
  try {
    return await import('./project-obligation-contract.js');
  } catch (error) {
    return { __load_error:error };
  }
}

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

test('obligation graph profile preserves finite acyclic all-of semantics', async () => {
  const contract = await loadContract();
  assert.equal(contract.__load_error, undefined, 'project-obligation-contract.js must exist');
  assert.equal(contract.PROJECT_OBLIGATION_GRAPH_PROFILE, 'overcenter-obligation-dag-v1');
  assert.deepEqual(contract.PROJECT_OBLIGATION_GRAPH_CONTRACT.workflow, {
    dependency_semantics:'all',
    acyclic:true,
    transition_fires_at_most_once:true,
    token_accounting:false,
  });
});

test('obligation semantic input separates logical key and runtime state from semantic content', async () => {
  const contract = await loadContract();
  assert.equal(contract.__load_error, undefined, 'project-obligation-contract.js must exist');
  const input = contract.projectObligationSemanticInput(transition());
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

test('graph semantic input is stable across transition and dependency ordering', async () => {
  const contract = await loadContract();
  assert.equal(contract.__load_error, undefined, 'project-obligation-contract.js must exist');
  const left = contract.projectObligationGraphSemanticInput({
    project_ref:'github:owner/repo',
    authority:{ revision:'a'.repeat(40) },
    transitions:[
      transition({ id:'C', priority:1, requires:['B', 'A'] }),
      transition({ id:'A', priority:99, requires:[] }),
      transition({ id:'B', priority:42, requires:['A'] }),
    ],
  });
  const right = contract.projectObligationGraphSemanticInput({
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

test('satisfied obligations must be predecessor closed', async () => {
  const contract = await loadContract();
  assert.equal(contract.__load_error, undefined, 'project-obligation-contract.js must exist');
  const transitions = [
    transition({ id:'A', requires:[] }),
    transition({ id:'B', requires:['A'] }),
    transition({ id:'C', requires:['B'] }),
  ];
  assert.deepEqual(contract.assertPredecessorClosedObligationSet(transitions, ['A', 'B']), ['A', 'B']);
  assert.throws(
    () => contract.assertPredecessorClosedObligationSet(transitions, ['B']),
    (error) => error?.code === 'PROJECT_OBLIGATION_PREDECESSOR_CLOSURE_INVALID'
      && error?.details?.transition_id === 'B'
      && error?.details?.missing_requirement === 'A',
  );
});

test('historical obligation claims require exact authority provenance', async () => {
  const contract = await loadContract();
  assert.equal(contract.__load_error, undefined, 'project-obligation-contract.js must exist');
  assert.deepEqual(contract.assertExactObligationAuthorityCoordinate({
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
    () => contract.assertExactObligationAuthorityCoordinate({
      kind:'github', repository:'owner/repo', revision:'abc123', derivation:'overcenter-project-graph-v1',
    }),
    (error) => error?.code === 'PROJECT_OBLIGATION_AUTHORITY_INVALID',
  );
});
