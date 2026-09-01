function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) fail('PROJECT_TRANSITION_STALE_RECONCILIATION_INVALID', `${field} is invalid`, { field });
  return normalized;
}

function instant(value, field) {
  const milliseconds = Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)) fail('PROJECT_TRANSITION_LEASE_STATE_INVALID', `${field} is not a valid instant`, { field, value:value ?? null });
  return milliseconds;
}

export function createProjectTransitionStaleAuthorityReconciler({ store, now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.getRun !== 'function' || typeof store.getLease !== 'function' || typeof store.getSlot !== 'function'
      || typeof store.settleLeaseAtomically !== 'function') {
    throw new TypeError('project transition stale reconciliation store is incomplete');
  }

  async function reconcile(input = {}) {
    const leaseRef = text(input.lease_ref, 'lease_ref', 128);
    const runId = text(input.run_id, 'run_id');
    const idempotencyKey = text(input.idempotency_key, 'idempotency_key', 256);
    const staleError = input.stale_error;
    if (staleError?.code !== 'PROJECT_TRANSITION_AUTHORITY_STALE' || staleError?.details?.lease_ref !== leaseRef) {
      fail('PROJECT_TRANSITION_STALE_RECONCILIATION_UNPROVEN', 'stale project transition authority must be proven by canonical lease revalidation', { lease_ref:leaseRef });
    }

    const row = await store.getLease(leaseRef);
    if (!row) fail('PROJECT_TRANSITION_LEASE_INVALID', 'project transition lease reference is unknown');
    if (row.run_id !== runId) fail('PROJECT_TRANSITION_LEASE_SCOPE_MISMATCH', 'project transition lease belongs to a different run', { lease_ref:leaseRef });
    if (row.status === 'settled') {
      if (row.disposition === 'requeue' && row.settle_idempotency_key === idempotencyKey) {
        return Object.freeze({ ok:true, schema:'project-transition-stale-reconciliation-v1', lease_ref:leaseRef, run_id:runId, status:'settled', disposition:'requeue', idempotent_replay:true });
      }
      fail('PROJECT_TRANSITION_LEASE_ALREADY_SETTLED', 'project transition lease was already settled by a different request', { lease_ref:leaseRef });
    }

    const observedAt = now();
    if (row.status !== 'active' || instant(row.expires_at, 'lease.expires_at') <= instant(observedAt, 'now')) {
      fail('PROJECT_TRANSITION_LEASE_STALE', 'project transition lease is not active', { lease_ref:leaseRef, status:row.status });
    }
    const run = await store.getRun(runId);
    if (!run || run.status !== 'active' || instant(run.deadline_at, 'run.deadline_at') <= instant(observedAt, 'now')) {
      fail('PROJECT_TRANSITION_LEASE_STALE', 'project transition lease run is not active', { lease_ref:leaseRef, run_id:runId });
    }
    const slot = await store.getSlot(row.slot_key);
    if (!slot || slot.lease_id !== leaseRef || instant(slot.expires_at, 'slot.expires_at') <= instant(observedAt, 'now')) {
      fail('PROJECT_TRANSITION_LEASE_STALE', 'project transition lease no longer owns its exclusive slot', { lease_ref:leaseRef });
    }
    if (staleError.details.expected_revision !== row.authority_revision) {
      fail('PROJECT_TRANSITION_STALE_RECONCILIATION_UNPROVEN', 'stale-authority evidence does not match the durable lease revision', { lease_ref:leaseRef });
    }

    const updated = await store.settleLeaseAtomically({
      lease_id:leaseRef,
      slot_key:row.slot_key,
      run_id:runId,
      project_ref:row.project_ref,
      transition_id:row.transition_id,
      repository:row.repository,
      authority_revision:row.authority_revision,
      authority_derivation:row.authority_derivation,
      graph_fingerprint:row.graph_fingerprint,
      transition_definition_fingerprint:row.transition_definition_fingerprint,
      transition_revision_fingerprint:row.transition_revision_fingerprint,
      transition_dependency_fingerprint:row.transition_dependency_fingerprint,
      disposition:'requeue',
      settle_idempotency_key:idempotencyKey,
      settled_at:observedAt,
      graph_revision_change:null,
    });
    return Object.freeze({
      ok:true,
      schema:'project-transition-stale-reconciliation-v1',
      lease_ref:updated.lease_id,
      subject:'project_transition',
      run_id:updated.run_id,
      project_ref:updated.project_ref,
      transition_id:updated.transition_id,
      status:'settled',
      disposition:'requeue',
      reason:staleError.details.reason || 'authority-changed',
      previous_revision:row.authority_revision,
      current_revision:staleError.details.actual_revision || null,
      idempotent_replay:false,
    });
  }

  return Object.freeze({ reconcile });
}