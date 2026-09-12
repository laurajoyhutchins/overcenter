// API and database providers are injected by the runtime composition root.
import { createOrchestrationMaintenanceService, createPostgresOrchestrationMaintenanceStore } from './orchestration-runs.js';
import { createProjectTransitionLeasePostgresStore, reconcileExpiredLeaseItem } from './project-transition-lease-store.js';
import { createPostgresWorkLeaseService } from './work-leases.js';

export function createSubjectAwareLeaseRecovery({ dbBinding, workLeases, projectTransitions, now = () => new Date().toISOString() } = {}) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('dbBinding is required');
  if (!workLeases) throw new TypeError('workLeases is required');
  return Object.freeze({
    claim(input) { return workLeases.claim(input); },
    settle(input) { return workLeases.settle(input); },
    async reconcileExpired(workRef, gate) {
      const observedAt = now();
      if (gate === 'project_transition') {
        const canonical = await dbBinding.query(
          `SELECT subject_key AS work_ref,lease_ref::text AS lease_id,expires_at,
                  'project_transition' AS gate,'project_transition' AS subject
             FROM execution_state
            WHERE subject_key=$1
              AND subject_kind='project_transition'
              AND settled=false
              AND lease_ref IS NOT NULL
            LIMIT 1`,
          [workRef],
        );
        const canonicalItem = canonical?.rows?.[0] || null;
        if (canonicalItem) {
          if (canonicalItem.expires_at && Date.parse(String(canonicalItem.expires_at)) > Date.parse(String(observedAt))) {
            return Object.freeze({
              released_without_linear_mutation:false,
              recovery_required:true,
              mutation_certainty:'may_have_mutated',
              reason:'CANONICAL_EXECUTION_NOT_EXPIRED',
              subject:'project_transition',
              slot_key:String(workRef),
              lease_ref:String(canonicalItem.lease_id),
              observed_at:observedAt,
            });
          }
          return reconcileExpiredLeaseItem(canonicalItem, { workLeases, projectTransitions, observedAt });
        }
      }
      const result = await dbBinding.query(
        `SELECT s.work_ref,s.gate,s.lease_id::text AS lease_id,s.expires_at,
                COALESCE(l.claim_receipt->>'subject','work') AS subject
           FROM work_lease_slots s
           JOIN work_leases l ON l.lease_id=s.lease_id
          WHERE s.work_ref=$1 AND s.gate=$2
          LIMIT 1`,
        [workRef, gate],
      );
      const item = result?.rows?.[0] || null;
      if (!item) return Object.freeze({ released_without_linear_mutation:true, reason:'LEASE_SLOT_ALREADY_RELEASED' });
      return reconcileExpiredLeaseItem(item, { workLeases, projectTransitions, observedAt });
    },
  });
}

export function createPostgresSubjectAwareOrchestrationMaintenanceService(options = {}) {
  const dbBinding = options.db;
  const workLeases = options.workLeases || createPostgresWorkLeaseService({ db:dbBinding, api:options.api });
  const projectTransitions = options.projectTransitions || createProjectTransitionLeasePostgresStore(dbBinding);
  const leases = createSubjectAwareLeaseRecovery({ dbBinding, workLeases, projectTransitions, now:options.now });
  const executionRecoveries = Array.isArray(options.executionRecoveries) ? options.executionRecoveries : [];
  return createOrchestrationMaintenanceService({
    store:options.store || createPostgresOrchestrationMaintenanceStore(dbBinding),
    leases,
    executionRecoveries,
    limit:options.limit || 20,
    now:options.now,
  });
}