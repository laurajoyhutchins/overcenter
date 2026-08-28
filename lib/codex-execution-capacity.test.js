import { createCodexExecutionCapacity, normalizeCodexAllowanceObservation } from './codex-execution-capacity.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
function containsConcreteIdentity(value) {
  const forbidden = new Set(['device', 'device_id', 'device_name', 'environment', 'environment_id', 'host', 'hostname', 'machine', 'machine_id', 'provider', 'provider_id', 'region', 'runtime_id', 'vm', 'vm_id']);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => forbidden.has(key) || containsConcreteIdentity(nested));
}

export async function runCodexExecutionCapacityTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok:true }); } catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); } }

  await test('defaults to cloud preference without claiming cloud dispatch or quota', async () => {
    const capacity = createCodexExecutionCapacity();
    assert(capacity.policy.preferred_execution_class === 'codex_cloud', 'Codex Cloud is not the preferred policy class');
    assert(capacity.execution_classes.codex_cloud.state === 'unresolved', 'cloud availability was fabricated');
    assert(capacity.execution_classes.codex_cloud.dispatch_supported === false, 'unsupported cloud dispatch was claimed');
    assert(capacity.allowance.state === 'unknown', 'unknown allowance was not preserved');
  });

  await test('local execution is one unresolved class without a device registry', async () => {
    const capacity = createCodexExecutionCapacity();
    const local = capacity.execution_classes.codex_local;
    assert(local.kind === 'codex_local', 'local execution kind drifted');
    assert(local.state === 'unresolved', 'local execution was resolved prematurely');
    assert(local.dispatch_supported === false, 'local dispatch was claimed before a resolver exists');
    assert(!containsConcreteIdentity(capacity), 'capacity model contains concrete environment identity');
  });

  await test('future external execution remains abstract and unbound', async () => {
    const external = createCodexExecutionCapacity().execution_classes.external;
    assert(external.kind === 'external', 'external class drifted');
    assert(external.state === 'unbound', 'external class was bound to an implementation');
    assert(external.dispatch_supported === false, 'external dispatch was claimed');
  });

  await test('automatic paid fallback cannot be enabled', async () => {
    let code = null;
    try { createCodexExecutionCapacity({ paid_fallback_allowed:true }); } catch (error) { code = error?.code || null; }
    assert(code === 'CODEX_PAID_FALLBACK_DISABLED', `unexpected ${code}`);
    assert(createCodexExecutionCapacity({ paid_fallback_allowed:false }).policy.paid_fallback_allowed === false, 'paid fallback default changed');
  });

  await test('unknown and stale allowance observations remain explicit', async () => {
    const unknown = normalizeCodexAllowanceObservation({ state:'unknown' });
    const stale = normalizeCodexAllowanceObservation({ state:'stale', observed_at:'2026-08-28T04:00:00Z', windows:[{ kind:'primary', used_percent:42, reset_at:'2026-08-28T05:00:00Z' }] });
    assert(unknown.windows.length === 0, 'unknown allowance inferred quota windows');
    assert(stale.state === 'stale' && stale.windows[0].used_percent === 42, 'stale observation was promoted or discarded');
  });

  await test('bounded known allowance preserves only quota windows and timestamps', async () => {
    const allowance = normalizeCodexAllowanceObservation({
      state:'known',
      observed_at:'2026-08-28T04:10:00Z',
      windows:[
        { kind:'primary', used_percent:25, reset_at:'2026-08-28T05:10:00Z' },
        { kind:'secondary', used_percent:60, reset_at:'2026-09-01T12:00:00Z' },
      ],
    });
    assert(allowance.windows.length === 2, 'known allowance windows were lost');
    assert(allowance.windows[0].used_percent === 25 && allowance.windows[1].used_percent === 60, 'quota values changed');
    assert(!containsConcreteIdentity(allowance), 'allowance observation contains environment identity');
  });

  await test('concrete environment identity is rejected at the boundary', async () => {
    for (const input of [{ device_name:'workstation' }, { provider:'cloud-vendor' }, { hostname:'runner.example' }]) {
      let code = null;
      try { createCodexExecutionCapacity(input); } catch (error) { code = error?.code || null; }
      assert(code === 'CODEX_ENVIRONMENT_IDENTITY_FORBIDDEN', `identity input was not rejected: ${JSON.stringify(input)}`);
    }
  });

  return { ok:tests.every((test) => test.ok), passed:tests.filter((test) => test.ok).length, failed:tests.filter((test) => !test.ok).length, tests };
}
