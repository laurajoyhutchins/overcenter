import { db as hatchableDb } from 'hatchable';
import { canonicalJson, sha256Text } from './canonical-json.js';
import {
  createPostgresOrchestrationAdvanceService,
  createPostgresTargetAwareOrchestrationRunService,
} from './orchestration-run-target-runtime.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function normalizeProjectRef(value) {
  const projectRef = typeof value === 'string' ? value.trim() : '';
  const match = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(projectRef);
  if (!match) fail('REQUEST_INVALID', 'project_ref must name a GitHub repository project');
  return Object.freeze({ projectRef, repository:match[1] });
}

async function nextRunIdentity(dbBinding, projectRef, continuationKey) {
  const result = await dbBinding.query(
    `SELECT run_id,status,deadline_at
       FROM orchestration_runs
      WHERE continuation_key=$1 AND target->>'project_ref'=$2
      ORDER BY started_at DESC
      LIMIT 1`,
    [continuationKey, projectRef],
  );
  const latest = result.rows?.[0] || null;
  if (latest?.status === 'active') {
    if (Date.parse(latest.deadline_at) > Date.now()) return Object.freeze({ runId:latest.run_id, existing:true });
    fail('PROJECT_ADVANCE_RECOVERY_REQUIRED', 'latest project.advance run is overdue and must be reconciled before a successor run is created', {
      run_id:latest.run_id,
      recovery_operation:'orchestration.maintain',
    });
  }
  const digest = await sha256Text(canonicalJson({
    command:'project.advance',
    project_ref:projectRef,
    predecessor_run_id:latest?.run_id || null,
  }));
  return Object.freeze({ runId:`project-advance-${digest.slice(0, 32)}`, existing:false });
}

export function projectAdvanceFor(options = {}) {
  const dbBinding = options.db || hatchableDb;
  const runs = createPostgresTargetAwareOrchestrationRunService({ db:dbBinding });
  const advance = createPostgresOrchestrationAdvanceService({ db:dbBinding });

  async function startOrResumeProjectRun(rawProjectRef) {
    const { projectRef, repository } = normalizeProjectRef(rawProjectRef);
    const continuationKey = `semantic:project.advance:${projectRef}`;
    const identity = await nextRunIdentity(dbBinding, projectRef, continuationKey);
    if (identity.existing) return Object.freeze({ run_id:identity.runId });

    const request = {
      run_id:identity.runId,
      worker:'project.advance',
      mode:'interactive',
      continuation_key:continuationKey,
      scope:{
        project:projectRef,
        lanes:[],
        repositories:[repository],
        direction:'Advance the authoritative repository-owned project graph.',
      },
      target:{ project_ref:projectRef, horizon:{ kind:'project', ref:projectRef } },
      budget_seconds:10800,
      settlement_reserve_seconds:300,
      minimum_new_gate_seconds:600,
    };

    try {
      const started = await runs.start(request);
      return Object.freeze({ run_id:started.run_id });
    } catch (error) {
      if (String(error?.code || '') !== '23505') throw error;
      const replay = await runs.start(request);
      return Object.freeze({ run_id:replay.run_id });
    }
  }

  return Object.freeze({
    async advance(input) {
      const { projectRef } = normalizeProjectRef(input?.project_ref);
      const run = await startOrResumeProjectRun(projectRef);
      const result = await advance.advance({ run_id:run.run_id });
      if (result?.run_id !== run.run_id) fail('PROJECT_ADVANCE_RUN_MISMATCH', 'project advancement returned evidence for a different run');
      return result;
    },
  });
}