import { canonicalSettleCommandByRef } from 'lib/operator-commands.js';
import { WORK_SETTLE_INPUT_SCHEMA } from 'lib/work-settle-contract.js';
import { validateSemanticWorkerCommand } from 'lib/worker-transport.js';

const LEASE_REF = '00000000-0000-4000-8000-000000000145';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(name, fn) {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: String(error?.message || error) };
  }
}

function boundaryDb() {
  return {
    async query(sql, params) {
      if (sql.includes('WHERE lease_id = $1')) {
        check(params?.[0] === LEASE_REF, 'canonical settlement looked up a different lease reference');
        return { rows: [{ lease_id: LEASE_REF, run_id: 'settle-boundary-run', work_ref: 'LJH-470', gate: 'lane:verification', status: 'active', expires_at: '2026-08-27T17:00:00Z' }] };
      }
      throw new Error('unexpected database query in work.settle boundary regression');
    },
  };
}

export async function runWorkSettleBoundaryTests() {
  const results = [];

  results.push(await run('shared work.settle contract and semantic worker transport expose the same non-secret lease_ref selector', async () => {
    const required = new Set(WORK_SETTLE_INPUT_SCHEMA?.required || []);
    const properties = WORK_SETTLE_INPUT_SCHEMA?.properties || {};
    check(required.has('lease_ref'), 'shared work.settle contract does not require lease_ref');
    check(!required.has('lease_token'), 'shared work.settle contract still requires lease_token');
    check(Boolean(properties.lease_ref), 'shared work.settle contract does not expose lease_ref');
    check(!properties.lease_token, 'shared work.settle contract still exposes lease_token');

    const semantic = validateSemanticWorkerCommand('work.settle', { lease_ref: LEASE_REF, disposition: 'requeue' });
    check(semantic.lease_ref === LEASE_REF, 'semantic worker transport changed the lease reference');
    let error = null;
    try { validateSemanticWorkerCommand('work.settle', { lease_token: 'secret-capability', disposition: 'requeue' }); }
    catch (caught) { error = caught; }
    check(error?.code === 'REQUEST_INVALID', 'semantic worker transport accepted raw lease capability material');
  }));

  results.push(await run('lease_ref settlement canonicalization derives stable retry identity without capability material', async () => {
    const db = boundaryDb();
    const input = { lease_ref: LEASE_REF, disposition: 'requeue', evidence: [{ kind: 'regression', ref: 'overcenter#145' }], requeue_class: 'retry_runtime_failure' };
    const first = await canonicalSettleCommandByRef(input, db);
    const second = await canonicalSettleCommandByRef(input, db);
    check(first.lease_ref === LEASE_REF && second.lease_ref === LEASE_REF, 'canonical settlement lost lease_ref');
    check(!('lease_token' in first) && !('lease_token' in second), 'canonical settlement reconstructed or exposed lease capability material');
    check(first.run_id === 'settle-boundary-run', 'canonical settlement did not derive run correlation from the lease reference');
    check(/^auto:work\.settle:[0-9a-f]{64}$/.test(first.idempotency_key), 'canonical settlement did not derive a bounded retry identity');
    check(first.idempotency_key === second.idempotency_key, 'exact settlement replay changed retry identity');
  }));

  return {
    ok: results.every(result => result.ok),
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
    results,
  };
}
