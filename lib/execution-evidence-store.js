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

      const verifications = await rows(
        `SELECT p.proof_key AS predicate_key, p.subject_key AS work_ref,
                p.predicate_kind, p.satisfied_at, p.evidence_sha256,
                p.evidence, p.created_at
           FROM proof_state p
           JOIN execution_state e ON e.execution_id = p.execution_id
          WHERE e.run_id = $1
          ORDER BY p.satisfied_at ASC, p.proof_key ASC`,
        [runId],
      );

      return { run, horizons, leases, checkpoints, heartbeats, invocations, resolutions, verifications };
    },
  };
}
