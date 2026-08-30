import { api, db } from 'hatchable';
import { createOrchestrationDiagnosisService, createPostgresOrchestrationRecoveryStore } from './orchestration-recovery.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';
import { createLinearAuthority } from './work-leases.js';
import { classifyLeaseAuthority, durableLeaseSubject, projectTransitionLeaseProjection } from './orchestration-lease-authority.js';

function projectTransitionsFor(options, dbBinding) {
  if (options.projectTransitions && typeof options.projectTransitions.require === 'function') return options.projectTransitions;
  const graphRuntime = options.projectGraphRuntime || createGitHubProjectGraphRuntime({ ...options, db:dbBinding });
  const readProjectGraph = typeof options.projectGraphReader === 'function'
    ? options.projectGraphReader
    : createAuthoritativeProjectGraphReader(graphRuntime);
  const store = options.projectTransitionStore || createProjectTransitionLeasePostgresStore(dbBinding);
  return createProjectTransitionLeaseService({ store, readProjectGraph, now:options.now });
}

function graphNativeStoreFacade(store) {
  return new Proxy(store, {
    get(source, property, receiver) {
      if (property === 'getRun') {
        return async (runId) => {
          const run = await source.getRun(runId);
          return run ? { ...run, last_work_ref:null, last_gate:null } : run;
        };
      }
      if (property === 'latestLease') return async () => null;
      if (property === 'latestCheckpoint') return async () => null;
      const value = Reflect.get(source, property, receiver);
      return typeof value === 'function' ? value.bind(source) : value;
    },
  });
}

function graphWorkState(projection) {
  return Object.freeze({
    work_ref:projection.work_ref,
    observed:true,
    subject:'project_transition',
    authority_status:projection.authority_status,
    project_ref:projection.project_ref,
    transition_id:projection.transition_id,
    claimed_authority_revision:projection.claimed_authority_revision,
    current_authority_revision:projection.current_authority_revision,
  });
}

export function createSubjectAwareOrchestrationDiagnosisService({ store, authoritative, projectTransitions = null, now = () => new Date().toISOString() } = {}) {
  if (!store || !authoritative) throw new TypeError('store and authoritative are required');

  async function diagnose(input = {}) {
    const runId = typeof input?.run_id === 'string' ? input.run_id.trim() : '';
    const latestLease = runId && typeof store.latestLease === 'function' ? await store.latestLease(runId) : null;
    if (!latestLease || durableLeaseSubject(latestLease) !== 'project_transition') {
      return createOrchestrationDiagnosisService({ store, authoritative, now }).diagnose(input);
    }

    const classification = await classifyLeaseAuthority({ lease:latestLease, projectTransitions, run_id:runId });
    const projection = projectTransitionLeaseProjection(latestLease, classification);
    const requestedWorkRef = typeof input?.work_ref === 'string' ? input.work_ref.trim() : '';
    const graphNativeRequest = !requestedWorkRef || requestedWorkRef === latestLease.work_ref || requestedWorkRef.startsWith('project_transition:');
    const baseInput = graphNativeRequest ? { run_id:runId } : input;
    const base = await createOrchestrationDiagnosisService({
      store:graphNativeStoreFacade(store),
      authoritative,
      now,
    }).diagnose(baseInput);

    return Object.freeze({
      ...base,
      current_work_state:graphWorkState(projection),
      active_lease:classification.current ? projection : null,
      latest_lease:projection,
      project_transition_lease_state:Object.freeze({
        subject:'project_transition',
        authority_status:projection.authority_status,
        historical_reason:projection.historical_reason,
        lease_ref:projection.lease_id,
        project_ref:projection.project_ref,
        transition_id:projection.transition_id,
        claimed_authority_revision:projection.claimed_authority_revision,
        current_authority_revision:projection.current_authority_revision,
      }),
    });
  }

  return Object.freeze({ diagnose });
}

export function createPostgresSubjectAwareOrchestrationDiagnosisService(options = {}) {
  const dbBinding = options.db || db;
  return createSubjectAwareOrchestrationDiagnosisService({
    store:options.store || createPostgresOrchestrationRecoveryStore(dbBinding),
    authoritative:options.authoritative || createLinearAuthority(options.api || api),
    projectTransitions:projectTransitionsFor(options, dbBinding),
    now:options.now,
  });
}