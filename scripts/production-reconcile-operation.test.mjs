import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProduction } from '../lib/production-reconcile-operation.js';

const DEV = 'a'.repeat(40);
const PROD = 'b'.repeat(40);
const DRIFT = 'c'.repeat(40);

function runtime(revision, version = 506) {
  return { revision, verified:true, verification_ref:`immutable-runtime:prod:${version}:manifest`, deployment_version:version };
}

function fixture(overrides = {}) {
  const state = { development:DEV, production:PROD, runtime:runtime(PROD, 505), calls:[] };
  const ports = {
    resolveBranchRoles: async () => ({ development:'dev', production:'main' }),
    readBranchHeads: async () => { state.calls.push(['heads', state.development, state.production]); return { development_revision:state.development, production_revision:state.production }; },
    verifyDevelopmentRevision: async (_repo, revision) => { state.calls.push(['verify', revision]); return { revision, verified:true, verification_ref:'github-actions-run:42' }; },
    observeRuntime: async (_repo, revision) => { state.calls.push(['runtime', revision, state.runtime.revision]); return state.runtime; },
    promote: async (intent) => { state.calls.push(['promote', Object.keys(intent).sort()]); state.production = DEV; return { ok:true, source_revision:DEV, production_revision:DEV, verification_ref:'github-actions-run:42' }; },
    reconcileRuntime: async (_repo, revision) => { state.calls.push(['reconcile-runtime', revision]); state.runtime = runtime(DEV, 507); return { state:'succeeded', revision:DEV, verification_ref:state.runtime.verification_ref, deployment_version:507 }; },
    verifyFinalState: async (_repo, revision) => { state.calls.push(['final', revision]); return { development_revision:state.development, production_revision:state.production, runtime:state.runtime }; },
  };
  Object.assign(ports, typeof overrides === 'function' ? overrides(state) : overrides);
  return { state, ports };
}

async function failure(fn) {
  try { await fn(); } catch (error) { return error; }
  assert.fail('expected failure');
}

test('repo intent alone converges verified dev through promotion, authoritative reread, and exact runtime materialization', async () => {
  const { state, ports } = fixture();
  const result = await reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports);
  assert.deepEqual(state.calls.find(([name]) => name === 'promote')[1], ['repo']);
  const promote = state.calls.findIndex(([name]) => name === 'promote');
  const reread = state.calls.findIndex(([name], index) => name === 'heads' && index > promote);
  const materialize = state.calls.findIndex(([name]) => name === 'reconcile-runtime');
  assert.ok(promote >= 0 && reread > promote && materialize > reread);
  assert.deepEqual(result, {
    ok:true,
    outcome:'converged',
    repo:'laurajoyhutchins/overcenter',
    development_revision:DEV,
    production_revision:DEV,
    runtime_revision:DEV,
    development_verification_ref:'github-actions-run:42',
    runtime_verification_ref:'immutable-runtime:prod:507:manifest',
    deployment_version:507,
  });
});

test('already-converged verified state is a mutation-free no-op', async () => {
  let promoted = false;
  let reconciled = false;
  const { state, ports } = fixture(() => ({
    promote: async () => { promoted = true; throw new Error('unexpected'); },
    reconcileRuntime: async () => { reconciled = true; throw new Error('unexpected'); },
  }));
  state.production = DEV;
  state.runtime = runtime(DEV, 506);
  const result = await reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports);
  assert.equal(result.outcome, 'already_converged');
  assert.equal(promoted, false);
  assert.equal(reconciled, false);
});

test('production-current runtime-stale recovery skips promotion', async () => {
  let promoted = false;
  const { state, ports } = fixture(() => ({ promote: async () => { promoted = true; throw new Error('unexpected'); } }));
  state.production = DEV;
  state.runtime = runtime(PROD, 505);
  const result = await reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports);
  assert.equal(result.outcome, 'converged');
  assert.equal(promoted, false);
});

test('missing exact development verification fails before mutation', async () => {
  let promoted = false;
  let reconciled = false;
  const { ports } = fixture(() => ({
    verifyDevelopmentRevision: async (_repo, revision) => ({ revision, verified:false, verification_ref:'' }),
    promote: async () => { promoted = true; },
    reconcileRuntime: async () => { reconciled = true; },
  }));
  const error = await failure(() => reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports));
  assert.equal(error.code, 'PRODUCTION_RECONCILIATION_SOURCE_NOT_VERIFIED');
  assert.equal(error.may_have_mutated, false);
  assert.equal(promoted, false);
  assert.equal(reconciled, false);
});

test('post-promotion Git drift fails before runtime reconciliation', async () => {
  let reconciled = false;
  const { state, ports } = fixture(stateRef => ({
    promote: async () => { stateRef.production = DRIFT; return { ok:true, source_revision:DEV, production_revision:DEV }; },
    reconcileRuntime: async () => { reconciled = true; },
  }));
  const error = await failure(() => reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports));
  assert.equal(error.code, 'PRODUCTION_RECONCILIATION_GIT_DRIFT');
  assert.equal(error.may_have_mutated, true);
  assert.equal(reconciled, false);
  assert.equal(state.production, DRIFT);
});

test('indeterminate promotion prevents runtime reconciliation and preserves mutation uncertainty', async () => {
  let reconciled = false;
  const { ports } = fixture(() => ({
    promote: async () => { throw Object.assign(new Error('transport lost'), { code:'GITHUB_PRODUCTION_PROMOTION_INDETERMINATE', may_have_mutated:true }); },
    reconcileRuntime: async () => { reconciled = true; },
  }));
  const error = await failure(() => reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports));
  assert.equal(error.code, 'GITHUB_PRODUCTION_PROMOTION_INDETERMINATE');
  assert.equal(error.may_have_mutated, true);
  assert.equal(reconciled, false);
});

test('queued materialization returns a convergent pending outcome without final success', async () => {
  const { state, ports } = fixture(() => ({
    reconcileRuntime: async () => ({ state:'queued', revision:DEV, run_ref:'github-actions-run:99', mutation_attempted:false }),
  }));
  state.production = DEV;
  const result = await reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports);
  assert.equal(result.outcome, 'materialization_pending');
  assert.equal(result.materialization_run_ref, 'github-actions-run:99');
  assert.equal(state.calls.some(([name]) => name === 'final'), false);
});

test('indeterminate materialization fails closed and cannot claim convergence', async () => {
  const { state, ports } = fixture(() => ({
    reconcileRuntime: async () => ({ state:'indeterminate', revision:DEV, run_ref:null, mutation_attempted:true }),
  }));
  state.production = DEV;
  const error = await failure(() => reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports));
  assert.equal(error.code, 'PRODUCTION_RECONCILIATION_MATERIALIZATION_INDETERMINATE');
  assert.equal(error.may_have_mutated, true);
});

test('immutable runtime mismatch fails closed', async () => {
  const { state, ports } = fixture(stateRef => ({
    reconcileRuntime: async () => ({ state:'succeeded', revision:DEV, verification_ref:'immutable-runtime:prod:507:manifest', deployment_version:507 }),
    verifyFinalState: async () => ({ development_revision:DEV, production_revision:DEV, runtime:runtime(DRIFT, 507) }),
  }));
  state.production = DEV;
  const error = await failure(() => reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports));
  assert.equal(error.code, 'PRODUCTION_RECONCILIATION_RUNTIME_MISMATCH');
});

test('final Git drift prevents convergence success', async () => {
  const { state, ports } = fixture(() => ({
    verifyFinalState: async () => ({ development_revision:DRIFT, production_revision:DEV, runtime:runtime(DEV, 507) }),
  }));
  state.production = DEV;
  state.runtime = runtime(PROD, 505);
  const error = await failure(() => reconcileProduction({ repo:'laurajoyhutchins/overcenter' }, ports));
  assert.equal(error.code, 'PRODUCTION_RECONCILIATION_FINAL_DRIFT');
});

test('caller mechanical coordinates are rejected', async () => {
  const { ports } = fixture();
  const error = await failure(() => reconcileProduction({ repo:'laurajoyhutchins/overcenter', candidate_sha:DEV }, ports));
  assert.equal(error.code, 'PRODUCTION_RECONCILIATION_REQUEST_INVALID');
  assert.deepEqual(error.details.unsupported_fields, ['candidate_sha']);
});