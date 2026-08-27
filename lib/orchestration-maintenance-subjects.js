import { api, db } from 'hatchable';
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
      return reconcileExpiredLeaseItem(item, { workLeases, projectTransitions, observedAt:now() });
    },
  });
}

export function createPostgresSubjectAwareOrchestrationMaintenanceService(options = {}) {
  const dbBinding = options.db || db;
  const workLeases = options.workLeases || createPostgresWorkLeaseService({ db:dbBinding, api:options.api || api });
  const projectTransitions = options.projectTransitions || createProjectTransitionLeasePostgresStore(dbBinding);
  const leases = createSubjectAwareLeaseRecovery({ dbBinding, workLeases, projectTransitions, now:options.now });
  return createOrchestrationMaintenanceService({
    store:options.store || createPostgresOrchestrationMaintenanceStore(dbBinding),
    leases,
    limit:options.limit || 20,
    now:options.now,
  });
}