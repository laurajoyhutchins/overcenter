import {
  evaluateScheduledCycleWindow,
  evaluateCorrectiveActionsTerminal,
  createDeterministicWorkSettlementService,
} from './deterministic-work-settlement.js';

function assert(value, message) { if (!value) throw new Error(message); }

class FakeCycleStore {
  constructor(ids = []) { this.ids = ids; }
  async cycleIdsSince() { return [...this.ids]; }
}
class FakeCycleService {
  constructor(statuses = {}) { this.statuses = statuses; this.calls = 0; }
  async status({ cycle_id }) { this.calls += 1; return this.statuses[cycle_id]; }
}
class FakeLinear {
  constructor() { this.issues = new Map(); this.updates = 0; }
  put(ref, type = 'unstarted', name = 'Todo') { this.issues.set(ref, { identifier:ref, id:`id-${ref}`, updatedAt:`rev-${ref}-${this.updates}`, state:{ type, name } }); }
  async getIssue(ref) { const value = this.issues.get(ref); return value ? JSON.parse(JSON.stringify(value)) : null; }
  async settle(ref, stateName) { const issue = this.issues.get(ref); this.updates += 1; issue.state = { type:stateName === 'Done' ? 'completed' : 'canceled', name:stateName }; issue.updatedAt = `rev-${ref}-${this.updates}`; return this.getIssue(ref); }
}
class FakeReceipts {
  constructor() { this.rows = new Map(); this.writes = 0; }
  async get(key) { return this.rows.get(key) || null; }
  async record(row) { this.writes += 1; if (!this.rows.has(row.predicate_key)) this.rows.set(row.predicate_key, JSON.parse(JSON.stringify(row))); return this.rows.get(row.predicate_key); }
}

function healthy(cycle) { return { ok:true, cycle_id:cycle, complete:true, healthy:true, scheduler_acceptance_complete:true, participant_count:5, records:[] }; }
function unhealthy(cycle) { return { ok:true, cycle_id:cycle, complete:true, healthy:false, scheduler_acceptance_complete:true, participant_count:5, records:[] }; }

export async function runDeterministicWorkSettlementTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok:true }); } catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); } }

  await test('scheduled-cycle predicate satisfies after three healthy complete cycles', async () => {
    const ids = ['2026-08-21T19:00:00.000Z','2026-08-21T20:00:00.000Z','2026-08-21T21:00:00.000Z'];
    const statuses = Object.fromEntries(ids.map(id => [id, healthy(id)]));
    const result = await evaluateScheduledCycleWindow({
      cycleStore:new FakeCycleStore(ids),
      cycleService:new FakeCycleService(statuses),
      predicate:{ after:'2026-08-21T00:00:00.000Z', minimum_healthy_cycles:3 },
    });
    assert(result.satisfied === true && result.matching_cycle_ids.length === 3, 'three healthy cycles did not satisfy predicate');
  });

  await test('scheduler acceptance incompleteness is reported but does not fail an otherwise matching accounting cycle', async () => {
    const ids = ['2026-08-21T19:00:00.000Z','2026-08-21T20:00:00.000Z','2026-08-21T21:00:00.000Z'];
    const statuses = Object.fromEntries(ids.map(id => [id, { ...healthy(id), scheduler_acceptance_complete:false }]));
    const result = await evaluateScheduledCycleWindow({
      cycleStore:new FakeCycleStore(ids),
      cycleService:new FakeCycleService(statuses),
      predicate:{ after:'2026-08-21T00:00:00.000Z', minimum_healthy_cycles:3 },
    });
    assert(result.satisfied === true && result.matching_cycle_ids.length === 3, 'unavailable scheduler acceptance incorrectly failed the accounting gate');
  });

  await test('scheduled-cycle predicate remains unsatisfied below threshold', async () => {
    const ids = ['a','b','c'];
    const statuses = { a:healthy('a'), b:healthy('b'), c:unhealthy('c') };
    const result = await evaluateScheduledCycleWindow({
      cycleStore:new FakeCycleStore(ids),
      cycleService:new FakeCycleService(statuses),
      predicate:{ after:'2026-08-21T00:00:00.000Z', minimum_healthy_cycles:3 },
    });
    assert(result.satisfied === false && result.matching_cycle_ids.length === 2, 'partial evidence incorrectly satisfied predicate');
  });

  await test('satisfied deterministic predicate records receipt and terminalizes work once', async () => {
    const ids = ['1','2','3'];
    const statuses = Object.fromEntries(ids.map(id => [id, healthy(id)]));
    const linear = new FakeLinear(); linear.put('LJH-117'); const receipts = new FakeReceipts();
    const service = createDeterministicWorkSettlementService({
      cycleStore:new FakeCycleStore(ids), cycleService:new FakeCycleService(statuses), linear, receiptStore:receipts,
      predicates:[{ predicate_key:'ljh-117-shadow-v1', work_ref:'LJH-117', kind:'scheduled_cycle_window', after:'2026-08-21T00:00:00.000Z', minimum_healthy_cycles:3, target_state:'Done' }],
      now:() => '2026-08-22T17:00:00.000Z',
    });
    const first = await service.reconcile(); const second = await service.reconcile();
    assert(first.settled_count === 1 && second.settled_count === 0, 'deterministic settlement was not idempotent');
    assert((await linear.getIssue('LJH-117')).state.name === 'Done' && linear.updates === 1 && receipts.writes === 1, 'receipt/state settlement incorrect');
  });

  await test('corrective-action closure is structural and machine evaluated', async () => {
    const linear = new FakeLinear(); linear.put('LJH-117','completed','Done'); linear.put('LJH-118','canceled','Canceled'); linear.put('LJH-121','completed','Done');
    const result = await evaluateCorrectiveActionsTerminal({ linear, predicate:{ corrective_actions:['LJH-117','LJH-118','LJH-121'] } });
    assert(result.satisfied === true && result.actions.every(action => action.terminal), 'terminal corrective actions did not structurally close');
  });

  await test('historical incident does not need to remain executable while corrective actions are pending', async () => {
    const linear = new FakeLinear(); linear.put('LJH-116','completed','Done'); linear.put('LJH-117','unstarted','Todo'); const receipts = new FakeReceipts();
    const service = createDeterministicWorkSettlementService({
      linear, receiptStore:receipts, cycleStore:new FakeCycleStore(), cycleService:new FakeCycleService(),
      predicates:[{ predicate_key:'ljh-116-closure-v1', work_ref:'LJH-116', kind:'corrective_actions_terminal', corrective_actions:['LJH-117'], target_state:'Done' }],
    });
    const result = await service.reconcile();
    assert(result.settled_count === 0 && (await linear.getIssue('LJH-116')).state.name === 'Done' && receipts.writes === 0, 'pending corrective action changed historical incident executability');
  });

  const failed = tests.filter(test => !test.ok);
  return { ok:failed.length === 0, passed:tests.length - failed.length, failed:failed.length, tests };
}