import { api, db } from 'hatchable';
import { createPostgresScheduledCycleStore, createScheduledCycleService } from 'lib/scheduled-cycle-completeness.js';

const TERMINAL_TYPES = new Set(['completed','canceled','duplicate']);

export const deterministicWorkPredicates = Object.freeze([
  Object.freeze({
    predicate_key:'ljh-117-scheduled-cycle-shadow-v1',
    work_ref:'LJH-117',
    kind:'scheduled_cycle_window',
    after:'2026-08-21T16:00:00.000Z',
    minimum_healthy_cycles:3,
    target_state:'Done',
  }),
  Object.freeze({
    predicate_key:'ljh-116-corrective-action-closure-v1',
    work_ref:'LJH-116',
    kind:'corrective_actions_terminal',
    corrective_actions:Object.freeze(['LJH-117','LJH-118','LJH-121']),
    target_state:'Done',
  }),
]);

function terminal(issue) {
  return Boolean(issue?.archivedAt) || TERMINAL_TYPES.has(String(issue?.state?.type || '').toLowerCase());
}

export async function evaluateScheduledCycleWindow({ cycleStore, cycleService, predicate } = {}) {
  if (!cycleStore || !cycleService) throw new TypeError('cycleStore and cycleService are required');
  const minimum = Number(predicate?.minimum_healthy_cycles || 0);
  if (!Number.isInteger(minimum) || minimum < 1) throw new TypeError('minimum_healthy_cycles must be a positive integer');
  const cycleIds = await cycleStore.cycleIdsSince(predicate.after);
  const matching = [];
  const evaluated = [];
  for (const cycleId of cycleIds || []) {
    const status = await cycleService.status({ cycle_id:cycleId });
    const satisfies = status?.complete === true
      && status?.healthy === true
      && Number(status?.participant_count) === 5;
    evaluated.push({
      cycle_id:status?.cycle_id || cycleId,
      complete:Boolean(status?.complete),
      healthy:Boolean(status?.healthy),
      scheduler_acceptance_complete:Boolean(status?.scheduler_acceptance_complete),
      participant_count:Number(status?.participant_count || 0),
      satisfies,
    });
    if (satisfies) matching.push(status?.cycle_id || cycleId);
  }
  return {
    satisfied:matching.length >= minimum,
    minimum_healthy_cycles:minimum,
    matching_cycle_ids:matching,
    evaluated_cycles:evaluated,
  };
}

export async function evaluateCorrectiveActionsTerminal({ linear, predicate } = {}) {
  if (!linear) throw new TypeError('linear is required');
  const refs = Array.isArray(predicate?.corrective_actions) ? predicate.corrective_actions : [];
  if (!refs.length) throw new TypeError('corrective_actions must contain at least one work reference');
  const actions = [];
  for (const ref of refs) {
    const issue = await linear.getIssue(ref);
    actions.push({
      work_ref:ref,
      found:Boolean(issue),
      terminal:terminal(issue),
      state:issue?.state?.name || null,
      state_type:issue?.state?.type || null,
    });
  }
  return { satisfied:actions.every(action => action.found && action.terminal), actions };
}

export async function evaluateDeterministicWorkPredicate({ predicate, cycleStore, cycleService, linear }) {
  if (predicate.kind === 'scheduled_cycle_window') return evaluateScheduledCycleWindow({ cycleStore, cycleService, predicate });
  if (predicate.kind === 'corrective_actions_terminal') return evaluateCorrectiveActionsTerminal({ linear, predicate });
  throw new Error(`unsupported deterministic work predicate kind: ${predicate.kind}`);
}

export function createDeterministicWorkSettlementService({
  cycleStore,
  cycleService,
  linear,
  predicates = deterministicWorkPredicates,
} = {}) {
  if (!linear) throw new TypeError('linear is required');

  async function reconcile() {
    const results = [];
    let settledCount = 0;
    for (const predicate of predicates) {
      const evaluation = await evaluateDeterministicWorkPredicate({ predicate, cycleStore, cycleService, linear });
      if (!evaluation.satisfied) {
        results.push({ predicate_key:predicate.predicate_key, work_ref:predicate.work_ref, status:'pending', evaluation });
        continue;
      }
      const issue = await linear.getIssue(predicate.work_ref);
      if (!issue) {
        results.push({ predicate_key:predicate.predicate_key, work_ref:predicate.work_ref, status:'work_not_found', evaluation });
        continue;
      }
      let settled = false;
      if (!terminal(issue)) {
        await linear.settle(predicate.work_ref, predicate.target_state || 'Done', issue.updatedAt);
        settled = true;
        settledCount += 1;
      }
      results.push({
        predicate_key:predicate.predicate_key,
        work_ref:predicate.work_ref,
        status:settled ? 'settled' : 'already_settled',
        evaluation,
      });
    }
    return { ok:true, settled_count:settledCount, receipt_count:0, results };
  }

  return { reconcile };
}

function linearError(message, details = null) {
  const error = new Error(message);
  error.code = 'LINEAR_UPSTREAM_ERROR';
  error.details = details;
  return error;
}

export function createDeterministicLinearAuthority(apiBinding = api) {
  async function gql(query, variables = {}) {
    const response = await apiBinding.call('linear', { method:'POST', path:'', headers:{ 'Content-Type':'application/json' }, body:{ query, variables } });
    const status = Number(response?.status || 0);
    let body = response?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (status < 200 || status >= 300 || body?.errors?.length) throw linearError(body?.errors?.[0]?.message || `Linear returned HTTP ${status || 'unknown'}`);
    return body?.data || {};
  }
  async function getIssue(ref) {
    const data = await gql(`query DeterministicWorkIssue($id: String!) {
      issue(id:$id) {
        id identifier updatedAt archivedAt state { id name type }
        team { id states(first:50) { nodes { id name type } } }
      }
    }`, { id:ref });
    return data.issue || null;
  }
  async function settle(ref, stateName, expectedRevision = null) {
    const fresh = await getIssue(ref);
    if (!fresh) throw linearError(`Linear issue ${ref} was not found`);
    if (expectedRevision && fresh.updatedAt !== expectedRevision) {
      const error = new Error('Linear issue changed before deterministic settlement');
      error.code = 'LINEAR_REVISION_MISMATCH';
      error.details = { expected_revision:expectedRevision, actual_revision:fresh.updatedAt };
      throw error;
    }
    if (terminal(fresh)) return fresh;
    const state = (fresh.team?.states?.nodes || []).find(candidate => candidate.name === stateName);
    if (!state) throw linearError(`Linear state ${stateName} is not configured for ${ref}`);
    const data = await gql(`mutation DeterministicWorkSettle($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id:$id,input:$input) { success }
    }`, { id:fresh.id, input:{ stateId:state.id } });
    if (data.issueUpdate?.success !== true) throw linearError(`Linear did not confirm deterministic settlement for ${ref}`);
    return getIssue(ref);
  }
  return { getIssue, settle };
}

export function createPostgresDeterministicWorkSettlementDependencies(options = {}) {
  const dbBinding = options.db || db;
  const cycleStore = options.cycleStore || createPostgresScheduledCycleStore(dbBinding);
  const cycleService = options.cycleService || createScheduledCycleService({ store:cycleStore, now:options.now });
  return {
    cycleStore,
    cycleService,
    linear:options.linear || createDeterministicLinearAuthority(options.api || api),
  };
}

export function createPostgresDeterministicWorkSettlementService(options = {}) {
  const dependencies = createPostgresDeterministicWorkSettlementDependencies(options);
  return createDeterministicWorkSettlementService({
    ...dependencies,
    predicates:options.predicates || deterministicWorkPredicates,
  });
}