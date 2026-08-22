import { db } from 'hatchable';
import { createPostgresOrchestrationRunService } from 'lib/orchestration-runs.js';
import { scheduledCycleIdForParticipant, scheduledCycleParticipants, scheduledRunId } from 'lib/scheduled-cycle-completeness.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';

const SCHEMA = 'scheduled-execution-context-v1';
const OPERATION_SCHEMA = 'scheduled-execution-operation-v1';
const TEAM = 'Ljh-projects';
const LANE_BY_PARTICIPANT = Object.freeze({
  'portfolio-dispatcher': null,
  'repository-implementation': 'lane:repo-implementation',
  'source-data-implementation': 'lane:source-implementation',
  'exact-head-verification': 'lane:verification',
  'portfolio-integration': 'lane:integration',
});
const OPERATION_FIELDS = Object.freeze({
  claim:new Set(['work_ref','observed_revision']),
  progress:new Set(['phase','next_action','candidate','completed','evidence','authority_revisions']),
  settle:new Set(['disposition','evidence','reason','promotion_condition','requeue_class','continuation','next_state','next_lane']),
  idle:new Set(),
});

function err(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function participantFor(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  const participant = scheduledCycleParticipants.find((candidate) => candidate.id === id) || null;
  if (!participant) throw err('REQUEST_INVALID', 'participant is not an ordinary scheduled participant', { field:'participant', participant:id || null });
  return participant;
}

function operationFor(value) {
  const operation = typeof value === 'string' ? value.trim() : '';
  if (!Object.prototype.hasOwnProperty.call(OPERATION_FIELDS, operation)) throw err('REQUEST_INVALID', 'operation is unsupported', { field:'operation', operation:operation || null });
  return operation;
}

function boundedOperationInput(operation, value) {
  const input = value == null ? {} : value;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw err('REQUEST_INVALID', 'input must be an object', { field:'input' });
  const unknown = Object.keys(input).filter((key) => !OPERATION_FIELDS[operation].has(key)).sort();
  if (unknown.length) throw err('REQUEST_INVALID', 'scheduled operation input contains unsupported fields', { operation, unsupported_fields:unknown });
  return { ...input };
}

function safeWorkerResult(body = {}) {
  const { lease_ref: _leaseRef, lease_id: _leaseId, lease_token: _leaseToken, run_id: _runId, ...safe } = body || {};
  return safe;
}

function finishDisposition(settlementDisposition) {
  if (settlementDisposition === 'completed') return 'completed';
  if (settlementDisposition === 'blocked') return 'blocked';
  return 'clean-stop';
}

export function createPostgresScheduledExecutionRuntimeStore(dbBinding = db) {
  return {
    async activeLeaseForRun(runId, observedAt = new Date().toISOString()) {
      const result = await dbBinding.query(
        `SELECT lease_id AS lease_ref,work_ref,gate,status,expires_at
           FROM work_leases
          WHERE run_id=$1
            AND status IN ('active','settling')
            AND expires_at > $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [runId, observedAt],
      );
      return result.rows?.[0] || null;
    },
  };
}

export function createScheduledExecutionContextService({
  runs = null,
  runtimeStore = null,
  transport = null,
  dbBinding = db,
  now = () => new Date().toISOString(),
} = {}) {
  const runService = runs || createPostgresOrchestrationRunService({ db:dbBinding, now });
  const store = runtimeStore || createPostgresScheduledExecutionRuntimeStore(dbBinding);
  const workerTransport = transport || ((command, input) => executeSemanticWorkerCommand(command, input, { db:dbBinding }));
  if (!runService || typeof runService.start !== 'function' || typeof runService.finish !== 'function') throw new TypeError('runs.start and runs.finish are required');
  if (!store || typeof store.activeLeaseForRun !== 'function') throw new TypeError('runtimeStore.activeLeaseForRun is required');
  if (typeof workerTransport !== 'function') throw new TypeError('transport is required');

  async function bootstrap(input = {}) {
    const allowed = new Set(['participant']);
    const unknown = Object.keys(input || {}).filter((key) => !allowed.has(key));
    if (unknown.length) throw err('REQUEST_INVALID', 'scheduled bootstrap accepts participant only', { fields:unknown.sort() });
    const participant = participantFor(input?.participant);
    const observedAt = now();
    const cycleId = scheduledCycleIdForParticipant(participant.id, observedAt);
    const runId = scheduledRunId(cycleId, participant.id);
    const lane = LANE_BY_PARTICIPANT[participant.id] || null;
    const scope = {
      team: TEAM,
      lanes: lane ? [lane] : [],
      repositories: [],
      direction: `Scheduled ${participant.title} execution`,
    };
    const run = await runService.start({
      run_id:runId,
      worker:participant.title,
      mode:'scheduled',
      continuation_key:`scheduled:${participant.id}`,
      scope,
    });
    return {
      ok:true,
      schema:SCHEMA,
      participant:participant.id,
      participant_title:participant.title,
      automation_id:participant.automation_id,
      cycle_id:cycleId,
      run_id:runId,
      lane,
      scope,
      run,
      work_authority_changed:false,
    };
  }

  async function execute(input = {}) {
    const allowed = new Set(['participant','operation','input']);
    const unknown = Object.keys(input || {}).filter((key) => !allowed.has(key)).sort();
    if (unknown.length) throw err('REQUEST_INVALID', 'scheduled execution accepts participant, operation, and input only', { fields:unknown });
    const participant = participantFor(input?.participant);
    const operation = operationFor(input?.operation);
    const semanticInput = boundedOperationInput(operation, input?.input);
    const context = await bootstrap({ participant:participant.id });
    const publicContext = { participant:participant.id, cycle_id:context.cycle_id, lane:context.lane };

    if (operation === 'idle') {
      const active = await store.activeLeaseForRun(context.run_id, now());
      if (active) throw err('ACTIVE_LEASE_PRESENT', 'scheduled execution cannot declare idle while it owns an active lease', { work_ref:active.work_ref, gate:active.gate });
      const finished = await runService.finish({
        run_id:context.run_id,
        disposition:'no-work',
        last_work_ref:null,
        last_gate:context.lane,
        stop_reason:'scheduled runtime observed no eligible work',
      });
      return { ok:true, schema:OPERATION_SCHEMA, ...publicContext, operation, terminal:true, result:{ outcome:'idle' }, run_receipt:finished.run_receipt || null };
    }

    if (operation === 'claim') {
      const response = await workerTransport('work.claim', { ...semanticInput, run_id:context.run_id });
      if (response.status >= 400 || response.body?.ok !== true) return { ok:false, schema:OPERATION_SCHEMA, ...publicContext, operation, failure:response.body, http_status:response.status };
      return { ok:true, schema:OPERATION_SCHEMA, ...publicContext, operation, terminal:false, result:safeWorkerResult(response.body) };
    }

    const lease = await store.activeLeaseForRun(context.run_id, now());
    if (!lease) throw err('ACTIVE_LEASE_REQUIRED', `scheduled ${operation} requires the runtime-owned active lease`, { operation });

    if (operation === 'progress') {
      const response = await workerTransport('work.heartbeat', { lease_ref:lease.lease_ref, ...semanticInput });
      if (response.status >= 400 || response.body?.ok !== true) return { ok:false, schema:OPERATION_SCHEMA, ...publicContext, operation, failure:response.body, http_status:response.status };
      return { ok:true, schema:OPERATION_SCHEMA, ...publicContext, operation, terminal:false, result:safeWorkerResult(response.body) };
    }

    const response = await workerTransport('work.settle', { lease_ref:lease.lease_ref, ...semanticInput });
    if (response.status >= 400 || response.body?.ok !== true) return { ok:false, schema:OPERATION_SCHEMA, ...publicContext, operation, failure:response.body, http_status:response.status };
    const disposition = finishDisposition(semanticInput.disposition);
    const finished = await runService.finish({
      run_id:context.run_id,
      disposition,
      last_work_ref:lease.work_ref,
      last_gate:lease.gate,
      stop_reason:`scheduled runtime terminalized after work.settle:${semanticInput.disposition}`,
    });
    return {
      ok:true,
      schema:OPERATION_SCHEMA,
      ...publicContext,
      operation,
      terminal:true,
      result:safeWorkerResult(response.body),
      run_receipt:finished.run_receipt || null,
    };
  }

  return { bootstrap, execute };
}

export function createPostgresScheduledExecutionContextService(options = {}) {
  const dbBinding = options.db || db;
  return createScheduledExecutionContextService({
    runs: options.runs || createPostgresOrchestrationRunService({ ...options, db:dbBinding }),
    runtimeStore: options.runtimeStore || createPostgresScheduledExecutionRuntimeStore(dbBinding),
    transport: options.transport || ((command, input) => executeSemanticWorkerCommand(command, input, { db:dbBinding })),
    dbBinding,
    now: options.now,
  });
}

export function statusForScheduledExecutionContextError(error) {
  const code = String(error?.code || '');
  if (code === 'REQUEST_INVALID') return 400;
  if (['ACTIVE_LEASE_REQUIRED','ACTIVE_LEASE_PRESENT'].includes(code)) return 409;
  return 500;
}

export const scheduledExecutionContextConfig = Object.freeze({
  schema:SCHEMA,
  operation_schema:OPERATION_SCHEMA,
  team:TEAM,
  lanes:LANE_BY_PARTICIPANT,
  operations:Object.freeze(Object.keys(OPERATION_FIELDS)),
});
