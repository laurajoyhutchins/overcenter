import { executeWorkClaimBoundary } from 'lib/work-claim-boundary.js';
import { workLeaseInternals } from 'lib/work-leases.js';

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

function boundaryDb({ claimCount = 0 } = {}) {
  return {
    async query(sql) {
      if (sql.includes('SELECT claim_idempotency_key')) return { rows: [] };
      if (sql.includes('count(*)::int AS count')) return { rows: [{ count: claimCount }] };
      throw new Error('journal unavailable in work.claim boundary regression');
    },
  };
}

export async function runWorkClaimBoundaryTests() {
  const results = [];

  results.push(await run('contract-valid semantic claim derives a lease-valid internal retry key', async () => {
    const captured = [];
    const service = {
      async claim(request) {
        captured.push({ ...request });
        return { ok: true, work_ref: request.work_ref, lease_id: `lease-${captured.length}` };
      },
    };
    const input = {
      work_ref: 'LJH-467',
      run_id: 'boundary-run',
      observed_revision: '2026-08-27T15:27:30.682Z',
    };
    const first = await executeWorkClaimBoundary(input, { db: boundaryDb(), service });
    const second = await executeWorkClaimBoundary(input, { db: boundaryDb(), service });

    check(first.status === 200 && second.status === 200, 'contract-valid semantic claim did not reach the lease service');
    check(captured.length === 2, 'semantic boundary did not execute the lease service exactly once per request');
    check(/^auto:work\.claim:[0-9a-f]{64}$/.test(captured[0].idempotency_key), 'semantic boundary did not derive a bounded work.claim retry key');
    check(captured[0].idempotency_key === captured[1].idempotency_key, 'exact replay changed derived retry identity');
    check(captured[0].expected_revision === input.observed_revision, 'semantic boundary did not preserve the authoritative revision fence');
    check(captured[0].expected_state === null && captured[0].expected_lane === null, 'semantic boundary reconstructed caller-owned state or lane');
    workLeaseInternals.normalizeClaimRequest(captured[0]);
  }));

  results.push(await run('materially different claim intent does not collide', async () => {
    const captured = [];
    const service = { async claim(request) { captured.push({ ...request }); return { ok: true, work_ref: request.work_ref, lease_id: `lease-${captured.length}` }; } };
    await executeWorkClaimBoundary({ work_ref:'LJH-467', run_id:'boundary-run-a', observed_revision:'2026-08-27T15:27:30.682Z' }, { db:boundaryDb(), service });
    await executeWorkClaimBoundary({ work_ref:'LJH-467', run_id:'boundary-run-b', observed_revision:'2026-08-27T15:27:30.682Z' }, { db:boundaryDb(), service });
    check(captured[0].idempotency_key !== captured[1].idempotency_key, 'different run claim intents collided');
  }));

  results.push(await run('canonicalization failure cannot reach lease mutation', async () => {
    let calls = 0;
    const service = { async claim() { calls += 1; return { ok:true }; } };
    const response = await executeWorkClaimBoundary({ work_ref:'LJH-467', run_id:'boundary-run', observed_revision:{} }, { db:boundaryDb(), service });
    check(response.status === 400, 'malformed authoritative revision did not fail at the semantic boundary');
    check(response.body?.error === 'REQUEST_INVALID', 'canonicalization failure lost REQUEST_INVALID');
    check(response.body?.may_have_mutated === false, 'canonicalization failure did not report mutation safety');
    check(calls === 0, 'lease service ran after canonicalization failed');
  }));

  return results;
}