import { resolveCompatibilityTransitionBinding } from './compatibility-transition-bindings.js';
import { createCompatibilityTransitionConfirmationService } from './compatibility-transition-confirmation.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function completedReceipt(row, workRef) {
  const receipt = row?.settle_receipt;
  const lifecycle = receipt?.lifecycle_resolution;
  const evidence = Array.isArray(receipt?.evidence) ? receipt.evidence : [];
  const valid = row?.status === 'settled'
    && receipt?.ok === true
    && String(receipt?.disposition || '').toLowerCase() === 'completed'
    && String(receipt?.current_state || '').toLowerCase() === 'done'
    && receipt?.execution_precondition_verified === true
    && lifecycle?.current_stage === 'CONFIRM'
    && lifecycle?.next_stage === 'DONE'
    && lifecycle?.condition === 'NOMINAL'
    && lifecycle?.complete === true
    && evidence.length > 0;
  if (!valid) fail('COMPATIBILITY_WORK_NOT_CONFIRMED', 'latest durable work settlement does not prove canonical CONFIRM completion', { work_ref:workRef });
  return Object.freeze({
    ok:true,
    confirm_complete:true,
    settlement_ref:String(row.lease_id),
    settled_at:row.settled_at || null,
    evidence:Object.freeze(evidence.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function createCompatibilityWorkSettlementReader(dbBinding) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('db.query is required');
  return Object.freeze({
    async requireCompleted({ work_ref } = {}) {
      const workRef = typeof work_ref === 'string' ? work_ref.trim() : '';
      if (!workRef) fail('COMPATIBILITY_TRANSITION_CONFIRMATION_INVALID', 'work_ref is required');
      const result = await dbBinding.query(
        `SELECT lease_id::text, status, settle_receipt, settled_at
         FROM work_leases
         WHERE work_ref=$1 AND status='settled'
         ORDER BY settled_at DESC NULLS LAST
         LIMIT 1`,
        [workRef],
      );
      const row = result?.rows?.[0] || null;
      if (!row) fail('COMPATIBILITY_WORK_NOT_CONFIRMED', 'no durable settled compatibility work exists', { work_ref:workRef });
      return completedReceipt(row, workRef);
    },
  });
}

export function createCompatibilityTransitionConfirmationRuntime(options = {}) {
  const dbBinding = options.db;
  if (!dbBinding) throw new TypeError('db is required');
  if (typeof options.readProjectGraph !== 'function') throw new TypeError('readProjectGraph is required');
  if (!options.projectTransitions) throw new TypeError('projectTransitions is required');
  const bindings = options.bindings || Object.freeze({
    async resolve({ work_ref } = {}) { return resolveCompatibilityTransitionBinding(work_ref); },
  });
  const compatibilityWork = options.compatibilityWork || createCompatibilityWorkSettlementReader(dbBinding);
  return createCompatibilityTransitionConfirmationService({
    bindings,
    compatibilityWork,
    readProjectGraph:options.readProjectGraph,
    projectTransitions:options.projectTransitions,
  });
}