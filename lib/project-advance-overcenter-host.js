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

function optionalText(value, field, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) fail('REQUEST_INVALID', `${field} is invalid`, { field });
  return normalized;
}

function transitionIdFrom(value) {
  const transitionId = optionalText(value, 'transition_id', 256);
  if (transitionId && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(transitionId)) {
    fail('REQUEST_INVALID', 'transition_id is invalid', { field:'transition_id' });
  }
  return transitionId;
}

function defaultSessionRefFactory() {
  return crypto.randomUUID();
}

function targetFor(projectRef, transitionId) {
  return Object.freeze({
    project_ref:projectRef,
    horizon:Object.freeze(transitionId
      ? { kind:'transition', ref:transitionId }
      : { kind:'project', ref:projectRef }),
  });
}

function publicTransition(node) {
  if (!node) return null;
  return Object.freeze({
    id:node.id,
    priority:node.priority,
    requires:Object.freeze([...(node.requires || [])]),
    unmet_requirements:Object.freeze([...(node.unmet_requirements || [])]),
    state:node.state,
    executor:Object.freeze({ ...(node.executor || {}) }),
    lifecycle:Object.freeze({ ...(node.lifecycle || {}) }),
  });
}

function exactStateResult(outcome, runId, projectRef, evaluation, node) {
  return Object.freeze({
    ok:true,
    schema:'orchestration-advance-v1',
    outcome,
    run_id:runId,
    project_ref:projectRef,
    horizon:evaluation.horizon,
    frontier:Object.freeze((evaluation.frontier || []).map((candidate) => candidate.id)),
    transition:publicTransition(node),
  });
}

export function projectAdvanceFor(options = {}) {
  const dbBinding = options.db || hatchableDb;
  const runs = options.runs || createPostgresTargetAwareOrchestrationRunService({ db:dbBinding });
  const orchestrationAdvance = options.orchestrationAdvance || createPostgresOrchestrationAdvanceService({ db:dbBinding });
  const sessionRefFactory = options.sessionRefFactory || defaultSessionRefFactory;

  async function startProjectRun(projectRef, repository, transitionId) {
    const sessionRef = optionalText(sessionRefFactory(), 'session_ref', 256);
    const digest = await sha256Text(canonicalJson({
      command:'project.advance',
      project_ref:projectRef,
      transition_id:transitionId,
      session_ref:sessionRef,
    }));
    const runId = `project-advance-${digest.slice(0, 32)}`;
    const continuationKey = `semantic:project.advance:${transitionId ? `transition:${transitionId}` : 'automatic'}:${sessionRef}`;
    const request = {
      run_id:runId,
      worker:'project.advance',
      mode:'interactive',
      continuation_key:continuationKey,
      scope:{
        project:projectRef,
        lanes:[],
        repositories:[repository],
        direction:transitionId
          ? `Advance exactly project transition ${transitionId}.`
          : 'Advance the authoritative repository-owned project graph.',
      },
      target:targetFor(projectRef, transitionId),
      budget_seconds:10800,
      settlement_reserve_seconds:300,
      minimum_new_gate_seconds:600,
    };

    try {
      const started = await runs.start(request);
      return Object.freeze({ run_id:started.run_id, created:true });
    } catch (error) {
      if (String(error?.code || '') !== '23505') throw error;
      const replay = await runs.start(request);
      return Object.freeze({ run_id:replay.run_id, created:true });
    }
  }

  async function resolveRun(projectRef, repository, transitionId, resumeRunId) {
    if (!resumeRunId) return startProjectRun(projectRef, repository, transitionId);
    const evaluation = await runs.resolveHorizon({ run_id:resumeRunId });
    const target = evaluation?.target || null;
    if (!target || target.project_ref !== projectRef) {
      fail('PROJECT_ADVANCE_RESUME_TARGET_MISMATCH', 'resume_run_id does not belong to the requested project', {
        run_id:resumeRunId,
        expected_project_ref:projectRef,
        actual_project_ref:target?.project_ref || null,
      });
    }
    if (transitionId && (target.horizon?.kind !== 'transition' || target.horizon?.ref !== transitionId)) {
      fail('PROJECT_ADVANCE_RESUME_TARGET_MISMATCH', 'resume_run_id does not target the requested transition', {
        run_id:resumeRunId,
        transition_id:transitionId,
        actual_horizon:target.horizon || null,
      });
    }
    return Object.freeze({ run_id:resumeRunId, created:false, evaluation });
  }

  async function exactTransitionPreflight(run, projectRef, transitionId) {
    if (!transitionId) return null;
    const evaluation = run.evaluation || await runs.resolveHorizon({ run_id:run.run_id });
    const target = evaluation?.target || null;
    if (!target || target.project_ref !== projectRef || target.horizon?.kind !== 'transition' || target.horizon?.ref !== transitionId) {
      fail('PROJECT_ADVANCE_TARGET_MISMATCH', 'project.advance exact transition run resolved incompatible target authority', {
        run_id:run.run_id,
        project_ref:projectRef,
        transition_id:transitionId,
        actual_target:target,
      });
    }
    const node = (evaluation.nodes || []).find((candidate) => candidate.id === transitionId) || null;
    if (!node) fail('PROJECT_ADVANCE_TARGET_MISSING', 'requested transition is absent from the authoritative target evaluation', { transition_id:transitionId });
    if (node.state === 'READY') return Object.freeze({ evaluation, node });
    if (node.state === 'DONE') return Object.freeze({ evaluation, node, result:exactStateResult('TARGET_COMPLETE', run.run_id, projectRef, evaluation, node) });
    if (node.state === 'WAITING') return Object.freeze({ evaluation, node, result:exactStateResult('TARGET_WAITING', run.run_id, projectRef, evaluation, node) });
    if (node.state === 'OFF_NOMINAL') return Object.freeze({ evaluation, node, result:exactStateResult('TARGET_BLOCKED', run.run_id, projectRef, evaluation, node) });
    fail('PROJECT_ADVANCE_TARGET_STATE_INVALID', 'requested transition resolved an unsupported authoritative state', { transition_id:transitionId, state:node.state || null });
  }

  return Object.freeze({
    async advance(input = {}) {
      const { projectRef, repository } = normalizeProjectRef(input?.project_ref);
      const transitionId = transitionIdFrom(input?.transition_id);
      const resumeRunId = optionalText(input?.resume_run_id, 'resume_run_id');
      const run = await resolveRun(projectRef, repository, transitionId, resumeRunId);
      const preflight = await exactTransitionPreflight(run, projectRef, transitionId);
      if (preflight?.result) return preflight.result;

      const result = await orchestrationAdvance.advance({ run_id:run.run_id });
      if (result?.run_id !== run.run_id) fail('PROJECT_ADVANCE_RUN_MISMATCH', 'project advancement returned evidence for a different run');
      if (transitionId && run.created && result?.outcome === 'WAITING') {
        return Object.freeze({
          ...result,
          outcome:'TARGET_OCCUPIED',
          transition:publicTransition(preflight?.node),
        });
      }
      return result;
    },
  });
}