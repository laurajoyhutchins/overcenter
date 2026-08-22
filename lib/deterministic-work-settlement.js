import { api, db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
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

async function evaluatePredicate({ predicate, cycleStore, cycleService, linear }) {
  if (predicate.kind === 'scheduled_cycle_window') return evaluateScheduledCycleWindow({ cycleStore, cycleService, predicate });
  if (predicate.kind === 'corrective_actions_terminal') return evaluateCorrectiveActionsTerminal({ linear, predicate });
  throw new Error(`unsupported deterministic work predicate kind: ${predicate.kind}`);
}

export function createDeterministicWorkSettlementService({
  cycleStore,
  cycleService,
  linear,
  receiptStore,
  predicates = deterministicWorkPredicates,
  now = () => new Date().toISOString(),
} = {}) {
  if (!linear || !receiptStore) throw new TypeError('linear and receiptStore are required');

  async function reconcile() {
    const results = [];
    let settledCount = 0;
    let receiptCount = 0;
    for (const predicate of predicates) {
      const existingReceipt = await receiptStore.get(predicate.predicate_key);
      if (existingReceipt) {
        results.push({ predicate_key:predicate.predicate_key, work_ref:predicate.work_ref, status:'already_settled', receipt:existingReceipt });
        continue;
      }
      const evaluation = await evaluatePredicate({ predicate, cycleStore, cycleService, linear });
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
      const evidence = {
        predicate:{ ...predicate },
        evaluation,
        work_ref:predicate.work_ref,
        target_state:predicate.target_state || 'Done',
        observed_work_state:issue.state?.name || null,
      };
      const evidenceSha = await sha256Text(canonicalJson(evidence));
      const receipt = await receiptStore.record({
        predicate_key:predicate.predicate_key,
        work_ref:predicate.work_ref,
        predicate_kind:predicate.kind,
        satisfied_at:now(),
        evidence_sha256:evidenceSha,
        evidence,
      });
      receiptCount += 1;
      results.push({ predicate_key:predicate.predicate_key, work_ref:predicate.work_ref, status:settled ? 'settled' : 'receipt_recorded', evaluation, receipt });
    }
    return { ok:true, settled_count:settledCount, receipt_count:receiptCount, results };
  }

  return { reconcile };
}

export function createPostgresVerificationReceiptStore(dbBinding = db) {
  return {
    async get(predicateKey) {
      const result = await dbBinding.query('SELECT * FROM portfolio_verification_receipts WHERE predicate_key=$1 LIMIT 1', [predicateKey]);
      return result.rows?.[0] || null;
    },
    async record(row) {
      const result = await dbBinding.query(`INSERT INTO portfolio_verification_receipts (predicate_key,work_ref,predicate_kind,satisfied_at,evidence_sha256,evidence)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (predicate_key) DO NOTHING
        RETURNING *`, [row.predicate_key,row.work_ref,row.predicate_kind,row.satisfied_at,row.evidence_sha256,canonicalJson(row.evidence || {})]);
      if (result.rows?.[0]) return result.rows[0];
      const existing = await dbBinding.query('SELECT * FROM portfolio_verification_receipts WHERE predicate_key=$1 LIMIT 1', [row.predicate_key]);
      return existing.rows?.[0] || null;
    },
  };
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

export function createPostgresDeterministicWorkSettlementService(options = {}) {
  const dbBinding = options.db || db;
  const cycleStore = options.cycleStore || createPostgresScheduledCycleStore(dbBinding);
  const cycleService = options.cycleService || createScheduledCycleService({ store:cycleStore, now:options.now });
  return createDeterministicWorkSettlementService({
    cycleStore,
    cycleService,
    linear:options.linear || createDeterministicLinearAuthority(options.api || api),
    receiptStore:options.receiptStore || createPostgresVerificationReceiptStore(dbBinding),
    predicates:options.predicates || deterministicWorkPredicates,
    now:options.now,
  });
}