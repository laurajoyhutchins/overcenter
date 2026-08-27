function requireDb(dbBinding) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('dbBinding.query is required');
  return dbBinding;
}

export function createPostgresExecutionEvidenceStore(dbBinding) {
  const database = requireDb(dbBinding);

  async function rows(sql, params = []) {
    const result = await database.query(sql, params);
    return Array.isArray(result?.rows) ? result.rows : [];
  }

  async function row(sql, params = []) {
    const result = await rows(sql, params);
    return result[0] || null;
  }

  return {
    async loadRunEvidence(runId) {
      const run = await row('SELECT * FROM orchestration_runs WHERE run_id = $1', [runId]);
      if (!run) return null;

      const horizons = await rows(
        `SELECT horizon_id, run_id, generation, candidates, horizon_sha256, created_at
           FROM orchestration_horizons
          WHERE run_id = $1
          ORDER BY generation ASC, horizon_id ASC`,
        [runId],
      );

      const leases = await rows(
        `SELECT lease_id, work_ref, gate, run_id, status, created_at, expires_at,
                previous_state, previous_lane, claim_revision, active_revision,
                claim_receipt, settle_plan, settle_receipt, settled_at,
                reconciliation, updated_at FROM work_leases WHERE run_id = $1
          ORDER BY created_at ASC, lease_id ASC`,
        [runId],
      );

      const checkpoints = await rows(
        `SELECT c.checkpoint_id, c.lease_id, c.request_sha256, c.checkpoint,
                c.checkpoint_sha256, c.created_at
           FROM work_lease_checkpoints c
           JOIN work_leases l ON l.lease_id = c.lease_id
          WHERE l.run_id = $1
          ORDER BY c.created_at ASC, c.checkpoint_id ASC`,
        [runId],
      );

      const heartbeats = await rows(
        `SELECT h.heartbeat_id, h.lease_id, h.request_sha256, h.progress_sha256,
                h.previous_expires_at, h.new_expires_at, h.created_at
           FROM work_lease_heartbeats h
           JOIN work_leases l ON l.lease_id = h.lease_id
          WHERE l.run_id = $1
          ORDER BY h.created_at ASC, h.heartbeat_id ASC`,
        [runId],
      );

      const invocations = await rows(
        `SELECT invocation_id, run_id, sequence, command, target_kind, target_ref,
                request_sha256, request_projection, started_at, completed_at,
                outcome, error_code, error_class, retryable, rejection,
                may_have_mutated, result_sha256, result_projection, schema_version FROM orchestration_command_invocations WHERE run_id = $1
          ORDER BY sequence ASC, invocation_id ASC`,
        [runId],
      );

      const resolutions = await rows(
        `SELECT r.resolution_id, r.invocation_id, r.resolution_kind,
                r.evidence, r.created_at
           FROM orchestration_invocation_resolutions r
           JOIN orchestration_command_invocations i ON i.invocation_id = r.invocation_id
          WHERE i.run_id = $1
          ORDER BY r.created_at ASC, r.resolution_id ASC`,
        [runId],
      );

      const leaseIds = leases.map((lease) => String(lease.lease_id || '')).filter(Boolean);
      const invocationIds = invocations.map((invocation) => String(invocation.invocation_id || '')).filter(Boolean);
      const verifications = await rows(
        `SELECT predicate_key, work_ref, predicate_kind, satisfied_at,
                evidence_sha256, evidence, created_at
           FROM portfolio_verification_receipts
          WHERE evidence->>'run_id' = $1
             OR (cardinality($2::text[]) > 0 AND evidence->>'lease_id' = ANY($2::text[]))
             OR (cardinality($3::text[]) > 0 AND evidence->>'invocation_id' = ANY($3::text[]))
          ORDER BY satisfied_at ASC, predicate_key ASC`,
        [runId, leaseIds, invocationIds],
      );

      return { run, horizons, leases, checkpoints, heartbeats, invocations, resolutions, verifications };
    },
  };
}
