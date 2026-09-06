export function createOrchestrationMaintenanceService({ store, leases, projectAuthoringRecovery = null, limit = 20, now = () => new Date().toISOString() } = {}) {
  if (!store || !leases) throw new TypeError('store and leases are required');
  return {
    async maintain() {
      const actions = [];
      const observedAt = now();
      const expired = (await store.expiredSlots(limit)) || [];
      for (const item of expired.slice(0, Math.max(0, limit - actions.length))) {
        try { actions.push({ kind: 'expired_lease_reconciliation', work_ref: item.work_ref, gate: item.gate, result: await leases.reconcileExpired(item.work_ref, item.gate) }); }
        catch (error) { actions.push({ kind: 'expired_lease_reconciliation', work_ref: item.work_ref, gate: item.gate, error: String(error?.code || error?.message || 'failed') }); }
      }
      const stuck = (await store.stuckLeases(Math.max(0, limit - actions.length))) || [];
      for (const item of stuck.slice(0, Math.max(0, limit - actions.length))) {
        try {
          if (item.kind === 'claiming' && item.claim_request) actions.push({ kind: 'claim_replay', lease_id: item.lease_id || null, result: await leases.claim(item.claim_request) });
          else if (item.kind === 'settling' && item.settle_plan?.replay_request && item.lease_token && item.settle_idempotency_key) actions.push({ kind: 'settlement_replay', lease_id: item.lease_id || null, result: await leases.settle({ lease_token: item.lease_token, ...item.settle_plan.replay_request, idempotency_key: item.settle_idempotency_key }) });
        } catch (error) { actions.push({ kind: item.kind === 'claiming' ? 'claim_replay' : 'settlement_replay', lease_id: item.lease_id || null, error: String(error?.code || error?.message || 'failed') }); }
      }
      const unresolved = typeof store.unresolvedInvocations === 'function' ? (await store.unresolvedInvocations(Math.max(0, limit - actions.length))) || [] : [];
      for (const invocation of unresolved.slice(0, Math.max(0, limit - actions.length))) {
        if (typeof store.reconcileInvocation !== 'function') break;
        try { const result = await store.reconcileInvocation(invocation); if (result) actions.push({ kind: 'journal_reconciliation', invocation_id: invocation.invocation_id, result }); }
        catch (error) { actions.push({ kind: 'journal_reconciliation', invocation_id: invocation.invocation_id, error: String(error?.code || error?.message || 'failed') }); }
      }
      const authoringRemaining = Math.max(0, limit - actions.length);
      if (authoringRemaining > 0 && projectAuthoringRecovery && typeof projectAuthoringRecovery.maintain === 'function') {
        try {
          const recovered = await projectAuthoringRecovery.maintain(authoringRemaining);
          actions.push(...(Array.isArray(recovered) ? recovered.slice(0, authoringRemaining) : []));
        } catch (error) {
          actions.push({ kind:'project_authoring_reconciliation', outcome:'maintenance_error', error:String(error?.code || error?.message || 'failed') });
        }
      }
      const remaining = Math.max(0, limit - actions.length);
      const overdue = remaining > 0 && typeof store.overdueRuns === 'function' ? (await store.overdueRuns(observedAt, remaining)) || [] : [];
      for (const run of overdue.slice(0, Math.max(0, limit - actions.length))) {
        if (typeof store.reconcileAbandonedRun !== 'function') break;
        try {
          const result = await store.reconcileAbandonedRun(run.run_id, observedAt);
          if (result) actions.push({ kind: 'abandoned_run_reconciliation', run_id: run.run_id, result: { status: result.status, disposition: result.disposition } });
        } catch (error) {
          actions.push({ kind: 'abandoned_run_reconciliation', run_id: run.run_id, error: String(error?.code || error?.message || 'failed') });
        }
      }
      return { ok: true, schema: 'orchestration-maintenance-v1', actions, action_count: actions.length, semantic_work_mutations: 0, work_selection_performed: false };
    },
  };
}
