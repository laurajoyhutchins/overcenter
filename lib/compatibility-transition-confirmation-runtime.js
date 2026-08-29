import { resolveCompatibilityTransitionBinding } from './compatibility-transition-bindings.js';
import { createCompatibilityTransitionConfirmationService } from './compatibility-transition-confirmation.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function canonicalSettlement(row, workRef) {
  const receipt = row?.settle_receipt;
  const lifecycle = receipt?.lifecycle_resolution;
  const valid = row?.status === 'settled'
    && receipt?.ok === true
    && String(receipt?.disposition || '').toLowerCase() === 'completed'
    && String(receipt?.current_state || '').toLowerCase() === 'done'
    && receipt?.execution_precondition_verified === true
    && lifecycle?.current_stage === 'CONFIRM'
    && lifecycle?.next_stage === 'DONE'
    && lifecycle?.condition === 'NOMINAL'
    && lifecycle?.complete === true;
  if (!valid) fail('COMPATIBILITY_WORK_NOT_CONFIRMED', 'latest durable work settlement does not prove canonical CONFIRM completion', { work_ref:workRef });
  return receipt;
}

function fullSha(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function evidenceFromJournal(rows, workRef) {
  let integration = null;
  let production = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const projection = row?.result_projection;
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)) continue;
    const repo = typeof projection.repo === 'string' ? projection.repo.trim() : '';
    if (row.command === 'github.integration.reconcile') {
      const mergeSha = fullSha(projection.merge_commit_sha);
      if (repo && String(projection.outcome || '').toLowerCase() === 'merged' && mergeSha) {
        integration = Object.freeze({ kind:'github_integration', ref:`${repo}@${mergeSha}` });
      }
    }
    if (row.command === 'github.production.promote') {
      const productionHead = fullSha(projection.new_production_head);
      const verificationRunId = Number(projection.verification_run_id);
      if (repo && projection.verified === true && productionHead && Number.isInteger(verificationRunId) && verificationRunId > 0) {
        production = Object.freeze({ kind:'production_verification', ref:`${repo}@${productionHead}#run:${verificationRunId}` });
      }
    }
  }
  if (!integration || !production) {
    fail('COMPATIBILITY_WORK_EVIDENCE_REQUIRED', 'compatibility work requires same-run source integration and verified production evidence', { work_ref:workRef });
  }
  return Object.freeze([integration, production]);
}

async function compatibilityEvidence(dbBinding, row, receipt, workRef) {
  const embedded = Array.isArray(receipt?.evidence) ? receipt.evidence : [];
  if (embedded.length > 0) return Object.freeze(embedded.map((entry) => Object.freeze({ ...entry })));
  const runId = typeof row?.run_id === 'string' ? row.run_id.trim() : '';
  if (!runId) fail('COMPATIBILITY_WORK_EVIDENCE_REQUIRED', 'compatibility settlement has no exact execution run identity', { work_ref:workRef });
  const result = await dbBinding.query(
    `SELECT command, completed_at, result_projection
     FROM orchestration_command_invocations
     WHERE run_id=$1 AND outcome='succeeded'
       AND command IN ('github.integration.reconcile','github.production.promote')
     ORDER BY sequence ASC`,
    [runId],
  );
  return evidenceFromJournal(result?.rows || [], workRef);
}

export function createCompatibilityWorkSettlementReader(dbBinding) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('db.query is required');
  return Object.freeze({
    async requireCompleted({ work_ref } = {}) {
      const workRef = typeof work_ref === 'string' ? work_ref.trim() : '';
      if (!workRef) fail('COMPATIBILITY_TRANSITION_CONFIRMATION_INVALID', 'work_ref is required');
      const result = await dbBinding.query(
        `SELECT lease_id::text, run_id, status, settle_receipt, settled_at
         FROM work_leases
         WHERE work_ref=$1 AND status='settled'
         ORDER BY settled_at DESC NULLS LAST
         LIMIT 1`,
        [workRef],
      );
      const row = result?.rows?.[0] || null;
      if (!row) fail('COMPATIBILITY_WORK_NOT_CONFIRMED', 'no durable settled compatibility work exists', { work_ref:workRef });
      const receipt = canonicalSettlement(row, workRef);
      const evidence = await compatibilityEvidence(dbBinding, row, receipt, workRef);
      return Object.freeze({
        ok:true,
        confirm_complete:true,
        settlement_ref:String(row.lease_id),
        settled_at:row.settled_at || null,
        evidence,
      });
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