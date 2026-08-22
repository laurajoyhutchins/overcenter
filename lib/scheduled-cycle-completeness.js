import { db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';

const SCHEMA = 'scheduled-cycle-completeness-v1';
const DEADLINE_MINUTES = 15;
const MAX_EVIDENCE = 25;
const EVENT_TYPES = new Set(['accepted','acknowledged','claimed','idle','completed','verified','failed_closed','ambiguous','missing']);
const TERMINAL = new Set(['idle','completed','verified','failed_closed','missing','duplicated','reordered','ambiguous']);
const HEALTHY_TERMINAL = new Set(['idle','completed','verified']);
const RANK = Object.freeze({ accepted:1, acknowledged:2, claimed:3, idle:4, completed:4, verified:5, failed_closed:5, ambiguous:5, missing:6 });

export const scheduledCycleParticipants = Object.freeze([
  Object.freeze({ id:'portfolio-dispatcher', title:'Portfolio Dispatcher', minute:0, automation_id:'6a74054183c88191a47278f43c61a4dd' }),
  Object.freeze({ id:'repository-implementation', title:'Repository Implementation', minute:12, automation_id:'6a74051febd08191a86e737908a3e322' }),
  Object.freeze({ id:'source-data-implementation', title:'Source and Data Implementation', minute:24, automation_id:'6a74053648d88191bdcf9e6ad4ed1d8c' }),
  Object.freeze({ id:'exact-head-verification', title:'Exact-Head Verification', minute:36, automation_id:'6a74052aeeb48191a22b828fc8ecb715' }),
  Object.freeze({ id:'portfolio-integration', title:'Portfolio Integration', minute:48, automation_id:'6a740515088481919dd97d3be5d89b64' }),
]);

const PARTICIPANTS = new Map(scheduledCycleParticipants.map((participant) => [participant.id, participant]));

function err(code, message, details = null) { const error = new Error(message); error.code = code; error.details = details; return error; }
function requiredString(value, name, max = 512) { const text = typeof value === 'string' ? value.trim() : ''; if (!text || text.length > max) throw err('REQUEST_INVALID', `${name} is invalid`, { field:name }); return text; }
function optionalString(value, name, max = 1024) { if (value == null || value === '') return null; return requiredString(String(value), name, max); }
function iso(value, name) { const text = requiredString(value, name, 64); const ms = Date.parse(text); if (!Number.isFinite(ms)) throw err('REQUEST_INVALID', `${name} must be an ISO timestamp`, { field:name }); return new Date(ms).toISOString(); }
function optionalIso(value, name) { return value == null || value === '' ? null : iso(value, name); }
function participantFor(id) { const participant = PARTICIPANTS.get(requiredString(id, 'participant', 128)); if (!participant) throw err('REQUEST_INVALID', 'participant is not an ordinary scheduled participant', { participant:id }); return participant; }
function cycleIdForStart(date) { return `${date.toISOString().slice(0,13)}:00Z`; }
function cycleStart(cycleId) { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00Z$/.test(String(cycleId || ''))) throw err('REQUEST_INVALID', 'cycle_id must be YYYY-MM-DDTHH:00Z', { field:'cycle_id' }); const date = new Date(String(cycleId).replace(':00Z', ':00:00.000Z')); if (!Number.isFinite(date.getTime())) throw err('REQUEST_INVALID', 'cycle_id is invalid', { field:'cycle_id' }); return date; }
function scheduledAt(cycleId, participant) { const date = cycleStart(cycleId); date.setUTCMinutes(participant.minute, 0, 0); return date.toISOString(); }
function deadlineAt(cycleId, participant) { return new Date(Date.parse(scheduledAt(cycleId, participant)) + DEADLINE_MINUTES * 60000).toISOString(); }
function nearestCycle(participant, anchorIso) {
  const anchor = new Date(anchorIso);
  const candidates = [-1,0,1].map((offset) => {
    const base = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate(), anchor.getUTCHours() + offset, participant.minute, 0, 0));
    return { base, distance: Math.abs(base.getTime() - anchor.getTime()) };
  }).sort((a,b)=>a.distance-b.distance || a.base.getTime()-b.base.getTime());
  return cycleIdForStart(candidates[0].base);
}
function normalizeEvidence(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) throw err('REQUEST_INVALID', `evidence must contain at most ${MAX_EVIDENCE} entries`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw err('REQUEST_INVALID', `evidence[${index}] must be an object`);
    return { kind:requiredString(item.kind, `evidence[${index}].kind`, 128), ref:requiredString(item.ref, `evidence[${index}].ref`, 1024) };
  });
}
function latestValue(events, key) { for (let index = events.length - 1; index >= 0; index -= 1) if (events[index]?.[key] != null && events[index][key] !== '') return events[index][key]; return null; }
function earliestValue(events, key) { for (const event of events) if (event?.[key] != null && event[key] !== '') return event[key]; return null; }
function eventCount(events, type) { return events.filter((event) => event.event_type === type).length; }
function isReordered(events) {
  let maxRank = 0;
  for (const event of events) {
    const rank = RANK[event.event_type] || 0;
    if (rank < maxRank) return true;
    maxRank = Math.max(maxRank, rank);
  }
  return false;
}
function requestProjection(request) {
  return {
    cycle_id:request.cycle_id,
    participant:request.participant,
    automation_id:request.automation_id,
    event_type:request.event_type,
    scheduler_accepted_at:request.scheduler_accepted_at,
    reported_started_at:request.reported_started_at,
    run_id:request.run_id,
    run_receipt_sha256:request.run_receipt_sha256,
    request_id:request.request_id,
    linear_receipt_ref:request.linear_receipt_ref,
    production_version:request.production_version,
    source_commit:request.source_commit,
    evidence:request.evidence,
    source:request.source,
    idempotency_key:request.idempotency_key,
  };
}

async function normalizeAcknowledge(input, now) {
  const participant = participantFor(input?.participant);
  const automationId = requiredString(input?.automation_id, 'automation_id', 128);
  if (automationId !== participant.automation_id) throw err('SCHEDULER_IDENTITY_MISMATCH', 'automation_id does not match the registered participant', { participant:participant.id });
  const eventType = requiredString(input?.event_type, 'event_type', 64);
  if (!EVENT_TYPES.has(eventType) || eventType === 'missing') throw err('REQUEST_INVALID', 'event_type is unsupported for participant acknowledgement', { event_type:eventType });
  const observedAt = now();
  const reportedStartedAt = optionalIso(input?.reported_started_at, 'reported_started_at');
  const schedulerAcceptedAt = optionalIso(input?.scheduler_accepted_at, 'scheduler_accepted_at');
  if (eventType === 'acknowledged' && !reportedStartedAt) throw err('REQUEST_INVALID', 'acknowledged event requires reported_started_at', { field:'reported_started_at' });
  if (schedulerAcceptedAt && reportedStartedAt && Date.parse(schedulerAcceptedAt) > Date.parse(reportedStartedAt)) throw err('REQUEST_INVALID', 'scheduler_accepted_at cannot be after reported_started_at');
  const anchor = reportedStartedAt || schedulerAcceptedAt || observedAt;
  const cycleId = input?.cycle_id ? cycleIdForStart(cycleStart(input.cycle_id)) : nearestCycle(participant, anchor);
  const runReceiptSha = optionalString(input?.run_receipt_sha256, 'run_receipt_sha256', 128);
  if (runReceiptSha && !/^[0-9a-f]{64}$/.test(runReceiptSha)) throw err('REQUEST_INVALID', 'run_receipt_sha256 must be lowercase SHA-256');
  const sourceCommit = optionalString(input?.source_commit, 'source_commit', 128);
  if (sourceCommit && !/^[0-9a-f]{40,64}$/.test(sourceCommit)) throw err('REQUEST_INVALID', 'source_commit must be a Git/SHA identity');
  return {
    cycle_id:cycleId,
    participant:participant.id,
    automation_id:automationId,
    event_type:eventType,
    scheduler_accepted_at:schedulerAcceptedAt,
    reported_started_at:reportedStartedAt,
    observed_at:observedAt,
    run_id:optionalString(input?.run_id, 'run_id', 512),
    run_receipt_sha256:runReceiptSha,
    request_id:optionalString(input?.request_id, 'request_id', 512),
    linear_receipt_ref:optionalString(input?.linear_receipt_ref, 'linear_receipt_ref', 1024),
    production_version:optionalString(input?.production_version, 'production_version', 128),
    source_commit:sourceCommit,
    evidence:normalizeEvidence(input?.evidence),
    source:'participant',
    idempotency_key:requiredString(input?.idempotency_key, 'idempotency_key', 512),
  };
}

async function recordForParticipant({ participant, cycleId, events, store }) {
  const ordered = [...events].sort((a,b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  const externalEvents = ordered.filter((event) => event.source !== 'reconciler' && event.event_type !== 'missing');
  const duplicated = [...EVENT_TYPES].some((type) => type !== 'missing' && eventCount(ordered, type) > 1);
  const reordered = isReordered(ordered.filter((event) => event.event_type !== 'missing'));
  const missing = eventCount(ordered, 'missing') > 0 && eventCount(ordered, 'acknowledged') === 0;
  const ambiguous = eventCount(ordered, 'ambiguous') > 0;
  const failedClosed = eventCount(ordered, 'failed_closed') > 0;
  const explicitVerified = eventCount(ordered, 'verified') > 0;
  const explicitCompleted = eventCount(ordered, 'completed') > 0;
  const explicitIdle = eventCount(ordered, 'idle') > 0;
  const explicitClaimed = eventCount(ordered, 'claimed') > 0;
  const acknowledged = eventCount(ordered, 'acknowledged') > 0;
  const accepted = eventCount(ordered, 'accepted') > 0 || ordered.some((event) => event.scheduler_accepted_at);
  const runId = latestValue(ordered, 'run_id');
  const run = runId && typeof store.runEvidence === 'function' ? await store.runEvidence(runId) : null;
  const claimed = explicitClaimed || Number(run?.lease_count || 0) > 0;
  const runCompleted = run?.status === 'finished' && ['completed','clean-stop','no-work'].includes(run?.disposition);
  const idle = explicitIdle || (run?.status === 'finished' && run?.disposition === 'no-work' && Number(run?.lease_count || 0) === 0);
  const completed = explicitCompleted || runCompleted;
  let classification = 'expected';
  if (accepted) classification = 'accepted';
  if (earliestValue(ordered, 'reported_started_at')) classification = 'started';
  if (acknowledged) classification = 'acknowledged';
  if (claimed) classification = 'claimed';
  if (idle) classification = 'idle';
  else if (completed) classification = 'completed';
  if (explicitVerified) classification = 'verified';
  if (failedClosed) classification = 'failed_closed';
  if (missing) classification = 'missing';
  if (ambiguous) classification = 'ambiguous';
  if (reordered) classification = 'reordered';
  if (duplicated) classification = 'duplicated';
  return {
    schema:SCHEMA,
    cycle_id:cycleId,
    participant:participant.id,
    participant_title:participant.title,
    automation_id:participant.automation_id,
    scheduled_at:scheduledAt(cycleId, participant),
    acknowledgement_deadline_at:deadlineAt(cycleId, participant),
    classification,
    scheduler_accepted_at:earliestValue(ordered, 'scheduler_accepted_at'),
    started_at:earliestValue(ordered, 'reported_started_at'),
    first_external_evidence_at:externalEvents.length ? externalEvents.map((event)=>event.observed_at).sort()[0] : null,
    acknowledged,
    claimed,
    idle,
    completed,
    verified:explicitVerified,
    failed_closed:failedClosed,
    missing,
    ambiguous,
    duplicated,
    reordered,
    run_id:runId,
    run:run ? {
      run_id:run.run_id || runId,
      status:run.status || null,
      disposition:run.disposition || null,
      lease_count:Number(run.lease_count || 0),
      settlement_count:Number(run.settlement_count || 0),
      last_work_ref:run.last_work_ref || null,
      receipt_sha256:latestValue(ordered, 'run_receipt_sha256') || run.receipt_sha256 || null,
    } : (runId ? { run_id:runId, status:null, disposition:null, lease_count:0, settlement_count:0, last_work_ref:null, receipt_sha256:latestValue(ordered, 'run_receipt_sha256') } : null),
    request_id:latestValue(ordered, 'request_id'),
    linear_receipt_ref:latestValue(ordered, 'linear_receipt_ref'),
    production_version:latestValue(ordered, 'production_version'),
    source_commit:latestValue(ordered, 'source_commit'),
    evidence:ordered.flatMap((event)=>Array.isArray(event.evidence) ? event.evidence : []).slice(0, MAX_EVIDENCE),
    event_count:ordered.length,
  };
}

export function createScheduledCycleService({ store, now = () => new Date().toISOString() } = {}) {
  if (!store) throw new TypeError('store is required');

  async function status(input = {}) {
    const observedAt = input.observed_at ? iso(input.observed_at, 'observed_at') : now();
    const cycleId = input.cycle_id ? cycleIdForStart(cycleStart(input.cycle_id)) : cycleIdForStart(new Date(observedAt));
    const events = (await store.eventsForCycle(cycleId)) || [];
    const records = [];
    for (const participant of scheduledCycleParticipants) records.push(await recordForParticipant({ participant, cycleId, events:events.filter((event)=>event.participant === participant.id), store }));
    const complete = records.every((record)=>TERMINAL.has(record.classification));
    const schedulerAcceptanceComplete = records.every((record)=>Boolean(record.scheduler_accepted_at));
    const healthy = complete && records.every((record)=>HEALTHY_TERMINAL.has(record.classification) && record.first_external_evidence_at);
    return { ok:true, schema:SCHEMA, cycle_id:cycleId, observed_at:observedAt, complete, healthy, scheduler_acceptance_complete:schedulerAcceptanceComplete, participant_count:records.length, records, work_authority_changed:false };
  }

  async function acknowledge(input) {
    const request = await normalizeAcknowledge(input, now);
    const requestSha = await sha256Text(canonicalJson(requestProjection(request)));
    const existing = await store.eventByIdempotencyKey(request.idempotency_key);
    if (existing) {
      if (existing.request_sha256 !== requestSha) throw err('IDEMPOTENCY_CONFLICT', 'idempotency_key already exists with different scheduled-cycle semantics');
      const cycleStatus = await status({ cycle_id:existing.cycle_id, observed_at:request.observed_at });
      return { ok:true, event:existing, record:cycleStatus.records.find((record)=>record.participant === existing.participant), idempotent_replay:true, work_authority_changed:false };
    }
    const eventBody = { ...request, request_sha256:requestSha };
    eventBody.event_sha256 = await sha256Text(canonicalJson(eventBody));
    const event = await store.insertEvent(eventBody);
    const cycleStatus = await status({ cycle_id:event.cycle_id, observed_at:event.observed_at });
    return { ok:true, event, record:cycleStatus.records.find((record)=>record.participant === event.participant), idempotent_replay:false, work_authority_changed:false };
  }

  async function appendMissing(participant, cycleId, observedAt) {
    const events = (await store.eventsForCycle(cycleId)) || [];
    if (events.some((event)=>event.participant === participant.id && event.event_type === 'acknowledged')) return null;
    const idempotencyKey = `scheduled-cycle:missing:${cycleId}:${participant.id}`;
    if (await store.eventByIdempotencyKey(idempotencyKey)) return null;
    const request = {
      cycle_id:cycleId, participant:participant.id, automation_id:participant.automation_id, event_type:'missing',
      scheduler_accepted_at:null, reported_started_at:null, observed_at:observedAt, run_id:null, run_receipt_sha256:null,
      request_id:null, linear_receipt_ref:null, production_version:null, source_commit:null, evidence:[], source:'reconciler', idempotency_key:idempotencyKey,
    };
    const requestSha = await sha256Text(canonicalJson(requestProjection(request)));
    const eventBody = { ...request, request_sha256:requestSha };
    eventBody.event_sha256 = await sha256Text(canonicalJson(eventBody));
    try { return await store.insertEvent(eventBody); }
    catch (error) { if (String(error?.code || '').includes('UNIQUE') || error?.code === 'IDEMPOTENCY_CONFLICT') return null; throw error; }
  }

  async function reconcile(input = {}) {
    const observedAt = input.observed_at ? iso(input.observed_at, 'observed_at') : now();
    const observedMs = Date.parse(observedAt);
    const candidates = [];
    if (input.participant) {
      const participant = participantFor(input.participant);
      const anchor = new Date(observedMs - DEADLINE_MINUTES * 60000);
      let cycleId = nearestCycle(participant, anchor.toISOString());
      let deadline = deadlineAt(cycleId, participant);
      if (Date.parse(deadline) > observedMs) { const prior = new Date(cycleStart(cycleId).getTime() - 3600000); cycleId = cycleIdForStart(prior); deadline = deadlineAt(cycleId, participant); }
      candidates.push({ participant, cycleId, deadline });
    } else {
      for (const participant of scheduledCycleParticipants) {
        const anchor = new Date(observedMs - DEADLINE_MINUTES * 60000);
        const cycleId = nearestCycle(participant, anchor.toISOString());
        const deadline = deadlineAt(cycleId, participant);
        const lateness = observedMs - Date.parse(deadline);
        if (lateness >= 0 && lateness <= 120000) candidates.push({ participant, cycleId, deadline });
      }
    }
    const appended = [];
    for (const candidate of candidates) {
      if (Date.parse(candidate.deadline) > observedMs) continue;
      const event = await appendMissing(candidate.participant, candidate.cycleId, observedAt);
      if (event) appended.push(event);
    }
    return { ok:true, schema:SCHEMA, observed_at:observedAt, checked:candidates.map((candidate)=>({participant:candidate.participant.id,cycle_id:candidate.cycleId,deadline_at:candidate.deadline})), appended, appended_count:appended.length, work_authority_changed:false };
  }

  return { acknowledge, status, reconcile };
}

export function createPostgresScheduledCycleStore(dbBinding = db) {
  async function row(sql, params = []) { const result = await dbBinding.query(sql, params); return result.rows?.[0] || null; }
  return {
    async eventByIdempotencyKey(key) { return row('SELECT * FROM scheduled_cycle_events WHERE idempotency_key=$1', [key]); },
    async insertEvent(event) {
      try {
        return row(`INSERT INTO scheduled_cycle_events (cycle_id,participant,automation_id,event_type,scheduler_accepted_at,reported_started_at,observed_at,run_id,run_receipt_sha256,request_id,linear_receipt_ref,production_version,source_commit,evidence,source,idempotency_key,request_sha256,event_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18) RETURNING *`, [event.cycle_id,event.participant,event.automation_id,event.event_type,event.scheduler_accepted_at,event.reported_started_at,event.observed_at,event.run_id,event.run_receipt_sha256,event.request_id,event.linear_receipt_ref,event.production_version,event.source_commit,JSON.stringify(event.evidence || []),event.source,event.idempotency_key,event.request_sha256,event.event_sha256]);
      } catch (error) {
        if (String(error?.message || '').toLowerCase().includes('unique') || String(error?.code || '') === '23505') { const conflict=err('IDEMPOTENCY_CONFLICT','scheduled-cycle event identity already exists'); conflict.cause=error; throw conflict; }
        throw error;
      }
    },
    async eventsForCycle(cycleId) { const result=await dbBinding.query('SELECT * FROM scheduled_cycle_events WHERE cycle_id=$1 ORDER BY sequence ASC', [cycleId]); return result.rows || []; },
    async runEvidence(runId) {
      const run = await row(`SELECT r.run_id,r.status,r.disposition,r.last_work_ref,
        (SELECT count(*)::int FROM work_leases l WHERE l.run_id=r.run_id) AS lease_count,
        (SELECT count(*)::int FROM work_leases l WHERE l.run_id=r.run_id AND l.status='settled') AS settlement_count
        FROM orchestration_runs r WHERE r.run_id=$1`, [runId]);
      return run || null;
    },
  };
}

export function createPostgresScheduledCycleService(options = {}) { return createScheduledCycleService({ store:options.store || createPostgresScheduledCycleStore(options.db || db), now:options.now }); }
export function statusForScheduledCycleError(error) { const code=String(error?.code || 'SCHEDULED_CYCLE_ERROR'); if (code === 'REQUEST_INVALID') return 400; if (['IDEMPOTENCY_CONFLICT','SCHEDULER_IDENTITY_MISMATCH'].includes(code)) return 409; return 500; }
export const scheduledCycleCompletenessConfig = Object.freeze({ schema:SCHEMA, deadline_minutes:DEADLINE_MINUTES, participants:scheduledCycleParticipants });