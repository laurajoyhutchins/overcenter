import * as scheduledCycleModule from 'lib/scheduled-cycle-completeness.js';
import { createScheduledCycleService, scheduledCycleParticipants } from 'lib/scheduled-cycle-completeness.js';
import { PRODUCTIVE_STAGES, STAGE_COMMANDS } from 'lib/work-lifecycle.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }

class FakeStore {
  constructor() { this.events = []; this.runs = new Map(); }
  async eventByIdempotencyKey(key) { return this.events.find((event) => event.idempotency_key === key) || null; }
  async insertEvent(event) { const saved = { event_id: `event-${this.events.length + 1}`, sequence:this.events.length + 1, ...JSON.parse(JSON.stringify(event)) }; this.events.push(saved); return saved; }
  async eventsForCycle(cycleId) { return this.events.filter((event) => event.cycle_id === cycleId).map((event) => JSON.parse(JSON.stringify(event))); }
  async runEvidence(runId) { return this.runs.get(runId) || null; }
}

function serviceAt(iso, store = new FakeStore()) { return { store, service: createScheduledCycleService({ store, now: () => iso }) }; }

export async function runScheduledCycleCompletenessTests() {
  const results = [];

  results.push(await run('ledger defines the five ordinary scheduled participants and exact offsets', async () => {
    const compact = scheduledCycleParticipants.map((participant) => [participant.stage, participant.command, participant.minute, participant.automation_id]);
    assert(compact.length === 5, 'ordinary participant roster is not exactly five');
    assert(compact.map((item) => item[0]).join(',') === 'ENABLE,ACQUIRE,EXECUTE,COMMIT,CONFIRM', 'productive stage order changed');
    assert(compact.map((item) => item[1]).join(',') === 'work.enable,work.acquire,work.execute,work.commit,work.confirm', 'stage command order changed');
    assert(compact.map((item) => item[2]).join(',') === '0,12,24,36,48', 'participant minute offsets changed');
    assert(compact.every((item) => typeof item[3] === 'string' && item[3].length > 10), 'scheduler identities are not bound');
  }));

  results.push(await run('scheduler policy does not duplicate lifecycle stage or command membership', async () => {
    const policy = scheduledCycleModule.scheduledCycleSchedulePolicy;
    assert(Array.isArray(policy), 'scheduler-specific policy is not separated from lifecycle membership');
    assert(policy.length === PRODUCTIVE_STAGES.length, 'scheduler policy no longer covers the productive lifecycle');
    assert(policy.every((entry) => !Object.prototype.hasOwnProperty.call(entry, 'stage') && !Object.prototype.hasOwnProperty.call(entry, 'command')), 'scheduler policy duplicates lifecycle stage or command facts');
    assert(scheduledCycleParticipants.map((participant) => participant.stage).join(',') === PRODUCTIVE_STAGES.join(','), 'scheduled participants do not derive canonical lifecycle membership');
    assert(scheduledCycleParticipants.every((participant) => participant.command === STAGE_COMMANDS[participant.stage]), 'scheduled participant commands do not derive canonical lifecycle commands');
  }));

  results.push(await run('acknowledgement keeps reported prompt start distinct from first external evidence', async () => {
    const { service } = serviceAt('2026-08-21T15:12:40.000Z');
    const result = await service.acknowledge({
      participant: 'repository-implementation',
      automation_id: '6a74051febd08191a86e737908a3e322',
      reported_started_at: '2026-08-21T15:12:08.000Z',
      event_type: 'acknowledged',
      idempotency_key: 'repo:2026-08-21T15:00Z:ack',
    });
    assert(result.record.cycle_id === '2026-08-21T15:00Z', 'cycle was not derived from the nearest expected window');
    assert(result.record.started_at === '2026-08-21T15:12:08.000Z', 'reported prompt start was lost');
    assert(result.record.first_external_evidence_at === '2026-08-21T15:12:40.000Z', 'external evidence timestamp was not independently observed');
    assert(result.record.scheduler_accepted_at === null, 'scheduler acceptance was inferred from a Hatchable request');
  }));

  results.push(await run('idempotent acknowledgement replay does not manufacture a duplicate', async () => {
    const { service, store } = serviceAt('2026-08-21T15:24:10.000Z');
    const input = { participant:'source-data-implementation', automation_id:'6a74053648d88191bdcf9e6ad4ed1d8c', event_type:'acknowledged', reported_started_at:'2026-08-21T15:24:05.000Z', idempotency_key:'source:15:ack' };
    const first = await service.acknowledge(input);
    const replay = await service.acknowledge(input);
    assert(first.idempotent_replay === false && replay.idempotent_replay === true, 'retry identity did not produce a replay');
    assert(store.events.length === 1, 'idempotent replay appended a duplicate event');
    assert(replay.record.classification !== 'duplicated', 'idempotent retry was misclassified as a duplicate firing');
  }));

  results.push(await run('duplicate and reordered transitions are explicit classifications', async () => {
    const { service } = serviceAt('2026-08-21T15:50:00.000Z');
    const common = { participant:'portfolio-integration', automation_id:'6a740515088481919dd97d3be5d89b64', reported_started_at:'2026-08-21T15:48:01.000Z' };
    await service.acknowledge({ ...common, event_type:'completed', idempotency_key:'integration:completed-first' });
    await service.acknowledge({ ...common, event_type:'acknowledged', idempotency_key:'integration:ack-late' });
    let status = await service.status({ cycle_id:'2026-08-21T15:00Z' });
    let record = status.records.find((item) => item.participant === 'portfolio-integration');
    assert(record.reordered === true && record.classification === 'reordered', 'out-of-order lifecycle was not classified');
    await service.acknowledge({ ...common, event_type:'acknowledged', idempotency_key:'integration:ack-duplicate' });
    status = await service.status({ cycle_id:'2026-08-21T15:00Z' });
    record = status.records.find((item) => item.participant === 'portfolio-integration');
    assert(record.duplicated === true && record.classification === 'duplicated', 'duplicate acknowledgement was not classified');
  }));

  results.push(await run('deadline reconciliation appends durable missing evidence without inventing a start', async () => {
    const { service, store } = serviceAt('2026-08-21T15:15:01.000Z');
    const result = await service.reconcile({ observed_at:'2026-08-21T15:15:01.000Z' });
    assert(result.appended.some((item) => item.participant === 'portfolio-dispatcher' && item.event_type === 'missing'), 'dispatcher missing event was not appended by +15 minutes');
    const status = await service.status({ cycle_id:'2026-08-21T15:00Z', observed_at:'2026-08-21T15:15:01.000Z' });
    const record = status.records.find((item) => item.participant === 'portfolio-dispatcher');
    assert(record.classification === 'missing' && record.started_at === null, 'missing classification invented prompt start evidence');
    const second = await service.reconcile({ observed_at:'2026-08-21T15:15:30.000Z' });
    assert(second.appended.length === 0 && store.events.filter((event) => event.event_type === 'missing').length === 1, 'missing reconciliation was not idempotent');
  }));

  results.push(await run('worker run evidence correlates claim and terminal execution without replacing scheduler evidence', async () => {
    const store = new FakeStore();
    store.runs.set('run-verification', { run_id:'run-verification', status:'finished', disposition:'completed', lease_count:1, settlement_count:1, last_work_ref:'LJH-777', receipt_sha256:'a'.repeat(64) });
    const { service } = serviceAt('2026-08-21T15:37:00.000Z', store);
    await service.acknowledge({ participant:'exact-head-verification', automation_id:'6a74052aeeb48191a22b828fc8ecb715', event_type:'acknowledged', reported_started_at:'2026-08-21T15:36:03.000Z', run_id:'run-verification', idempotency_key:'verify:ack' });
    const status = await service.status({ cycle_id:'2026-08-21T15:00Z' });
    const record = status.records.find((item) => item.participant === 'exact-head-verification');
    assert(record.claimed === true && record.completed === true, 'run/lease evidence was not correlated');
    assert(record.run?.receipt_sha256 === 'a'.repeat(64) && record.run?.last_work_ref === 'LJH-777', 'run receipt identity was not retained');
    assert(record.scheduler_accepted_at === null, 'run evidence was incorrectly treated as scheduler acceptance');
  }));

  results.push(await run('healthy no-op cycle is provable from explicit participant evidence rather than HTTP success', async () => {
    const store = new FakeStore();
    const { service } = serviceAt('2026-08-21T16:05:00.000Z', store);
    for (const participant of scheduledCycleParticipants) {
      const started = `2026-08-21T15:${String(participant.minute).padStart(2,'0')}:02.000Z`;
      await service.acknowledge({ participant:participant.id, automation_id:participant.automation_id, event_type:'accepted', scheduler_accepted_at:started, idempotency_key:`${participant.id}:accepted` });
      await service.acknowledge({ participant:participant.id, automation_id:participant.automation_id, event_type:'acknowledged', reported_started_at:started, idempotency_key:`${participant.id}:ack` });
      await service.acknowledge({ participant:participant.id, automation_id:participant.automation_id, event_type:'idle', cycle_id:'2026-08-21T15:00Z', idempotency_key:`${participant.id}:idle` });
    }
    const status = await service.status({ cycle_id:'2026-08-21T15:00Z', observed_at:'2026-08-21T16:05:00.000Z' });
    assert(status.complete === true && status.healthy === true, 'healthy no-op cycle was not proven');
    assert(status.records.every((record) => record.classification === 'idle' && record.scheduler_accepted_at && record.first_external_evidence_at), 'no-op proof omitted required participant evidence');
  }));

  results.push(await run('execution health remains provable when scheduler acceptance evidence is unavailable', async () => {
    const { service } = serviceAt('2026-08-21T16:05:00.000Z');
    for (const participant of scheduledCycleParticipants) {
      const started = `2026-08-21T15:${String(participant.minute).padStart(2,'0')}:02.000Z`;
      await service.acknowledge({ participant:participant.id, automation_id:participant.automation_id, event_type:'acknowledged', reported_started_at:started, idempotency_key:`${participant.id}:health-ack` });
      await service.acknowledge({ participant:participant.id, automation_id:participant.automation_id, event_type:'idle', cycle_id:'2026-08-21T15:00Z', idempotency_key:`${participant.id}:health-idle` });
    }
    const status = await service.status({ cycle_id:'2026-08-21T15:00Z', observed_at:'2026-08-21T16:05:00.000Z' });
    assert(status.complete === true && status.healthy === true, 'explicit task evidence did not prove an operationally healthy cycle');
    assert(status.scheduler_acceptance_complete === false, 'missing scheduler acceptance evidence was hidden');
  }));

  results.push(await run('ambiguous acknowledgement remains distinct from missing and failed-closed', async () => {
    const { service } = serviceAt('2026-08-21T15:01:00.000Z');
    await service.acknowledge({ participant:'portfolio-dispatcher', automation_id:'6a74054183c88191a47278f43c61a4dd', event_type:'ambiguous', idempotency_key:'dispatch:ambiguous', evidence:[{kind:'request_id',ref:'req-1'}] });
    const status = await service.status({ cycle_id:'2026-08-21T15:00Z' });
    const record = status.records.find((item) => item.participant === 'portfolio-dispatcher');
    assert(record.classification === 'ambiguous' && record.missing === false && record.failed_closed === false, 'ambiguous state collapsed into another terminal class');
  }));

  results.push(await run('cycle record retains bounded scheduler, request, Linear, production, and source coordinates', async () => {
    const { service } = serviceAt('2026-08-21T15:12:30.000Z');
    await service.acknowledge({
      participant:'repository-implementation', automation_id:'6a74051febd08191a86e737908a3e322', event_type:'acknowledged', reported_started_at:'2026-08-21T15:12:01.000Z',
      run_id:'run-1', request_id:'request-1', linear_receipt_ref:'lease-1@revision-2', production_version:'165', source_commit:'f'.repeat(40),
      idempotency_key:'repo:coordinates', evidence:[{kind:'git_head',ref:'owner/repo@abc'}],
    });
    const status = await service.status({ cycle_id:'2026-08-21T15:00Z' });
    const record = status.records.find((item) => item.participant === 'repository-implementation');
    assert(record.automation_id === '6a74051febd08191a86e737908a3e322', 'scheduler identity missing');
    assert(record.run_id === 'run-1' && record.request_id === 'request-1', 'Hatchable correlation missing');
    assert(record.linear_receipt_ref === 'lease-1@revision-2', 'Linear receipt coordinate missing');
    assert(record.production_version === '165' && record.source_commit === 'f'.repeat(40), 'production/source provenance missing');
    assert(JSON.stringify(record).length < 12000, 'record is not bounded');
  }));

  results.push(await run('runtime-owned deterministic run projects start claim and completion without worker acknowledgements', async () => {
    const store = new FakeStore();
    const runId = 'scheduled:2026-08-21T15:00Z:repository-implementation';
    store.runs.set(runId, {
      run_id:runId, status:'finished', disposition:'completed', started_at:'2026-08-21T15:12:03.000Z', finished_at:'2026-08-21T15:18:00.000Z',
      lease_count:1, settlement_count:1, last_work_ref:'LJH-382',
    });
    const { service } = serviceAt('2026-08-21T15:20:00.000Z', store);
    const status = await service.status({ cycle_id:'2026-08-21T15:00Z' });
    const record = status.records.find((item)=>item.participant === 'repository-implementation');
    assert(record.classification === 'completed' && record.claimed === true && record.completed === true, 'runtime-owned lifecycle was not projected');
    assert(record.run_id === runId && record.started_at === '2026-08-21T15:12:03.000Z', 'deterministic run identity/start evidence was not projected');
    assert(record.first_external_evidence_at === '2026-08-21T15:12:03.000Z', 'runtime start did not count as external execution evidence');
    assert(record.acknowledged === false && record.event_count === 0, 'projection fabricated worker acknowledgement events');
  }));

  results.push(await run('runtime-owned blocked run derives failed-closed and suppresses missing reconciliation', async () => {
    const store = new FakeStore();
    const runId = 'scheduled:2026-08-21T15:00Z:portfolio-dispatcher';
    store.runs.set(runId, {
      run_id:runId, status:'finished', disposition:'blocked', started_at:'2026-08-21T15:00:02.000Z', finished_at:'2026-08-21T15:04:00.000Z',
      lease_count:0, settlement_count:0, last_work_ref:null,
    });
    const { service } = serviceAt('2026-08-21T15:15:01.000Z', store);
    const reconciliation = await service.reconcile({ participant:'portfolio-dispatcher', observed_at:'2026-08-21T15:15:01.000Z' });
    assert(reconciliation.appended_count === 0, 'missing event was appended despite durable runtime start evidence');
    const status = await service.status({ cycle_id:'2026-08-21T15:00Z' });
    const record = status.records.find((item)=>item.participant === 'portfolio-dispatcher');
    assert(record.classification === 'failed_closed' && record.failed_closed === true && record.missing === false, 'blocked runtime was not projected as failed-closed');
  }));

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}
