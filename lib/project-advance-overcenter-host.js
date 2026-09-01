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

function optionalText(value, field, max = 512) {
  if (value == null) return null;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max || /\s/.test(normalized)) {
    fail('REQUEST_INVALID', `${field} is invalid`, { field });
  }
  return normalized;
}

function targetFor(projectRef, transitionId) {
  return Object.freeze({
    project_ref:projectRef,
    horizon:Object.freeze(transitionId
      ? { kind:'transition', ref:transitionId }
      : { kind:'project', ref:projectRef }),
  });
}

function storedTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const projectRef = typeof value.project_ref === 'string' ? value.project_ref.trim() : '';
  const kind = typeof value.horizon?.kind === 'string' ? value.horizon.kind.trim() : '';
  const ref = typeof value.horizon?.ref === 'string' ? value.horizon.ref.trim() : '';
  return projectRef && kind && ref
    ? Object.freeze({ project_ref:projectRef, horizon:Object.freeze({ kind, ref }) })
    : null;
}

function defaultReadRun(dbBinding) {
  return async function readRun(runId) {
    const result = await dbBinding.query(
      'SELECT run_id,status,target FROM orchestration_runs WHERE run_id=$1 LIMIT 1',
      [runId],
    );
    return result.rows?.[0] || null;
  };
}

async function newRunIdentity(projectRef, target, sessionRef) {
  const digest = await sha256Text(canonicalJson({
    command:'project.advance',
    project_ref:projectRef,
    target,
    session_ref:sessionRef,
  }));
  return Object.freeze({
    runId:`project-advance-${digest.slice(0, 32)}`,
    continuationKey:target.horizon.kind === 'transition'
      ? `semantic:project.advance:transition:${target.horizon.ref}:${digest.slice(0, 16)}`
      : `semantic:project.advance:project:${digest}`,
  });
}

export function projectAdvanceFor(options = {}) {
  const dbBinding = options.db;
  const runs = options.runs || createPostgresTargetAwareOrchestrationRunService({ db:dbBinding });
  const advance = options.advance || createPostgresOrchestrationAdvanceService({ db:dbBinding });
  const readRun = options.readRun || defaultReadRun(dbBinding);
  const newSessionRef = options.newSessionRef || (() => crypto.randomUUID());

  async function startProjectRun(projectRef, repository, transitionId) {
    const target = targetFor(projectRef, transitionId);
    const sessionRef = optionalText(await newSessionRef(), 'session_ref');
    const identity = await newRunIdentity(projectRef, target, sessionRef);
    const request = {
      run_id:identity.runId,
      worker:'project.advance',
      mode:'interactive',
      continuation_key:identity.continuationKey,
      scope:{
        project:projectRef,
        lanes:[],
        repositories:[repository],
        direction:transitionId
          ? `Advance only authoritative project transition ${transitionId}.`
          : 'Advance the authoritative repository-owned project graph.',
      },
      target,
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

  async function resumeProjectRun(projectRef, resumeRef, transitionId) {
    const existing = await readRun(resumeRef);
    const target = storedTarget(existing?.target);
    if (!existing || existing.run_id !== resumeRef || !target) {
      fail('PROJECT_ADVANCE_RESUME_NOT_FOUND', 'project.advance resume_ref does not identify a durable targeted run', { resume_ref:resumeRef });
    }
    if (existing.status !== 'active') {
      fail('PROJECT_ADVANCE_RESUME_NOT_ACTIVE', 'project.advance resume_ref is not active', { resume_ref:resumeRef, status:existing.status || null });
    }
    if (target.project_ref !== projectRef) {
      fail('PROJECT_ADVANCE_RESUME_MISMATCH', 'project.advance resume_ref belongs to a different project', {
        resume_ref:resumeRef,
        expected_project_ref:projectRef,
        actual_project_ref:target.project_ref,
      });
    }
    if (transitionId && (target.horizon.kind !== 'transition' || target.horizon.ref !== transitionId)) {
      fail('PROJECT_ADVANCE_RESUME_TARGET_MISMATCH', 'project.advance resume_ref has incompatible transition selection', {
        resume_ref:resumeRef,
        expected_transition_id:transitionId,
        actual_target:target.horizon,
      });
    }
    return Object.freeze({ run_id:existing.run_id });
  }

  return Object.freeze({
    async advance(input = {}) {
      const { projectRef, repository } = normalizeProjectRef(input.project_ref);
      const transitionId = optionalText(input.transition_id, 'transition_id', 256);
      const resumeRef = optionalText(input.resume_ref, 'resume_ref');
      const run = resumeRef
        ? await resumeProjectRun(projectRef, resumeRef, transitionId)
        : await startProjectRun(projectRef, repository, transitionId);
      const result = await advance.advance({ run_id:run.run_id });
      if (result?.run_id !== run.run_id) fail('PROJECT_ADVANCE_RUN_MISMATCH', 'project advancement returned evidence for a different run');
      return Object.freeze({ ...result, resume_ref:run.run_id });
    },
  });
}
