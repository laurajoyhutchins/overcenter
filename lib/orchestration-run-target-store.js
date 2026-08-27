function row(dbBinding, sql, params = []) {
  return dbBinding.query(sql, params).then((result) => result.rows?.[0] || null);
}

export function createPostgresOrchestrationRunTargetStore(dbBinding, baseStore) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('dbBinding is required');
  if (!baseStore) throw new TypeError('baseStore is required');
  return new Proxy(baseStore, {
    get(source, property, receiver) {
      if (property === 'findPredecessorByTarget') {
        return (continuationKey, scopeSha256, targetSha256, excludeRunId) => row(
          dbBinding,
          "SELECT * FROM orchestration_runs WHERE continuation_key=$1 AND scope_sha256=$2 AND target_sha256 IS NOT DISTINCT FROM $3 AND run_id<>$4 AND (status='finished' OR deadline_at<=now()) ORDER BY started_at DESC LIMIT 1",
          [continuationKey, scopeSha256, targetSha256, excludeRunId],
        );
      }
      if (property === 'insertRunWithTarget') {
        return (run, target, targetSha256, journalRequestSha256) => row(
          dbBinding,
          `INSERT INTO orchestration_runs (run_id,worker,mode,continuation_key,scope,scope_sha256,start_request_sha256,base_start_request_sha256,started_at,deadline_at,settlement_reserve_seconds,minimum_new_gate_seconds,predecessor_run_id,status,contract_provenance,skill_policy,target,target_sha256)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18) RETURNING *`,
          [run.run_id,run.worker,run.mode,run.continuation_key,JSON.stringify(run.scope),run.scope_sha256,target ? journalRequestSha256 : run.start_request_sha256,target ? run.start_request_sha256 : null,run.started_at,run.deadline_at,run.settlement_reserve_seconds,run.minimum_new_gate_seconds,run.predecessor_run_id,run.status,JSON.stringify(run.contract_provenance || {}),JSON.stringify(run.skill_policy || {}),target ? JSON.stringify(target) : null,targetSha256],
        );
      }
      const value = Reflect.get(source, property, receiver);
      return typeof value === 'function' ? value.bind(source) : value;
    },
  });
}
