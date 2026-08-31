import { canonicalJson, sha256Text } from './canonical-json.js';
import { evaluateProjectGraph } from './project-graph.js';
import { buildProjectGraphRevisionEvidence, reconcileProjectTransitionChange, reconcileProjectTransitionPresence, reconcileProjectTransitionRemoval } from './project-graph-reconciliation.js';
import { projectTransitionDependencyFingerprint } from './project-transition-dependency-fingerprint.js';
import { projectTransitionRevisionFingerprint } from './project-transition-revision-fingerprint.js';
import { projectTransitionDefinitionFingerprint } from './project-transition-observations.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) fail('PROJECT_TRANSITION_LEASE_REQUEST_INVALID', `${field} is invalid`, { field });
  return normalized;
}

function instant(value, field) {
  const milliseconds = Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)) fail('PROJECT_TRANSITION_LEASE_STATE_INVALID', `${field} is not a valid instant`, { field, value:value ?? null });
  return milliseconds;
}

function leaseSeconds(value) {
  const seconds = value == null ? 1800 : Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 7200) {
    fail('PROJECT_TRANSITION_LEASE_REQUEST_INVALID', 'lease_seconds must be an integer from 60 to 7200', { field:'lease_seconds' });
  }
  return seconds;
}

function heartbeatSeconds(value) {
  const seconds = value == null ? 300 : Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) {
    fail('PROJECT_TRANSITION_LEASE_REQUEST_INVALID', 'extend_seconds must be an integer from 60 to 3600', { field:'extend_seconds' });
  }
  return seconds;
}

function definitionAuthority(graph) {
  const definition = graph?.authority?.definition;
  const repository = text(definition?.repository, 'authority.repository', 256);
  const revision = text(definition?.revision, 'authority.revision', 40).toLowerCase();
  const derivation = text(definition?.derivation, 'authority.derivation', 256);
  if (String(definition?.kind || '').toLowerCase() !== 'github' || !/^[0-9a-f]{40}$/.test(revision)) {
    fail('PROJECT_TRANSITION_AUTHORITY_INVALID', 'project transition authority must be an exact GitHub definition revision');
  }
  return Object.freeze({ kind:'github', repository, revision, derivation });
}

async function graphFingerprint(graph) {
  return sha256Text(canonicalJson({
    schema:graph?.schema ?? null,
    project_ref:graph?.project_ref ?? null,
    authority:graph?.authority ?? null,
    nodes:graph?.nodes ?? null,
  }));
}

function slotKey(projectRef, transitionId) {
  return `project_transition:${projectRef}:${transitionId}`;
}

function publicLease(row, authority, idempotentReplay = false, graphRevisionChange = null) {
  return Object.freeze({
    ok:true,
    schema:'project-transition-lease-v1',
    lease_ref:row.lease_id,
    subject:'project_transition',
    run_id:row.run_id,
    project_ref:row.project_ref,
    transition_id:row.transition_id,
    transition_definition_fingerprint:row.transition_definition_fingerprint,
    transition_revision_fingerprint:row.transition_revision_fingerprint,
    transition_dependency_fingerprint:row.transition_dependency_fingerprint,
    authority:Object.freeze({ ...authority }),
    graph_revision_change:graphRevisionChange,
    expires_at:row.expires_at,
    ownership_protocol:'project-transition-slot-v1',
    idempotent_replay:idempotentReplay,
  });
}

function staleAuthority(row, authority, details = {}) {
  fail('PROJECT_TRANSITION_AUTHORITY_STALE', 'project transition authority changed after lease acquisition', {
    lease_ref:row.lease_id,
    expected_revision:row.authority_revision,
    actual_revision:authority.revision,
    ...details,
  });
}

export function createProjectTransitionLeaseService({ store, readProjectGraph, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() } = {}) {
  if (!store || typeof store.getRun !== 'function' || typeof store.getLease !== 'function' || typeof store.getLeaseByAcquireIdempotency !== 'function'
      || typeof store.getSlot !== 'function' || typeof store.insertLease !== 'function' || typeof store.insertSlot !== 'function'
      || typeof store.updateLease !== 'function' || typeof store.deleteSlot !== 'function') {
    throw new TypeError('project transition lease store is incomplete');
  }
  if (typeof readProjectGraph !== 'function') throw new TypeError('readProjectGraph is required');

  async function currentLease(row, input = {}) {
    if (!row) fail('PROJECT_TRANSITION_LEASE_INVALID', 'project transition lease reference is unknown');
    const observedAtText = now();
    const observedAt = instant(observedAtText, 'now');
    if (row.status !== 'active' || instant(row.expires_at, 'lease.expires_at') <= observedAt) {
      fail('PROJECT_TRANSITION_LEASE_STALE', 'project transition lease is not active', { lease_ref:row.lease_id, status:row.status });
    }
    if (input.run_id && row.run_id !== input.run_id) {
      fail('PROJECT_TRANSITION_LEASE_SCOPE_MISMATCH', 'project transition lease belongs to a different run', { lease_ref:row.lease_id });
    }
    if (input.project_ref && row.project_ref !== input.project_ref) {
      fail('PROJECT_TRANSITION_LEASE_SCOPE_MISMATCH', 'project transition lease belongs to a different project', { lease_ref:row.lease_id });
    }
    if (input.transition_id && row.transition_id !== input.transition_id) {
      fail('PROJECT_TRANSITION_LEASE_SCOPE_MISMATCH', 'project transition lease belongs to a different transition', { lease_ref:row.lease_id });
    }
    if (input.repository && row.repository !== input.repository) {
      fail('PROJECT_TRANSITION_LEASE_SCOPE_MISMATCH', 'project transition lease does not cover the requested repository', { lease_ref:row.lease_id });
    }
    const run = await store.getRun(row.run_id);
    if (!run || run.status !== 'active' || instant(run.deadline_at, 'run.deadline_at') <= observedAt) {
      fail('PROJECT_TRANSITION_LEASE_STALE', 'project transition lease run is not active', { lease_ref:row.lease_id, run_id:row.run_id });
    }
    const graph = await readProjectGraph(Object.freeze({ project_ref:row.project_ref }));
    const authority = definitionAuthority(graph);
    const currentGraphFingerprint = await graphFingerprint(graph);
    const exactAuthority = authority.repository === row.repository
      && authority.revision === row.authority_revision
      && authority.derivation === row.authority_derivation
      && currentGraphFingerprint === row.graph_fingerprint;
    let graphRevisionChange = null;

    if (!exactAuthority) {
      if (typeof store.getActiveLeasesForTransition !== 'function') {
        staleAuthority(row, authority, { reason:'cross_revision_exclusivity_unavailable' });
      }
      const evaluated = evaluateProjectGraph(graph);
      const transition = evaluated.nodes.find((node) => node.id === row.transition_id) || null;
      if (!transition) {
        const removal = reconcileProjectTransitionRemoval({
          transition_id:row.transition_id,
          definition_fingerprint:row.transition_definition_fingerprint,
        }, {
          has_live_execution_authority:true,
          was_confirmed:false,
        });
        staleAuthority(row, authority, { reason:removal.kind, removal_reason:removal.reason });
      }
      const currentTransitionFingerprint = await projectTransitionDefinitionFingerprint(transition);
      if (!row.transition_revision_fingerprint || !row.transition_dependency_fingerprint) {
        staleAuthority(row, authority, { reason:'revision-identity-unavailable' });
      }
      const currentRevisionFingerprint = await projectTransitionRevisionFingerprint({
        transition_id:transition.id, priority:transition.priority, executor:transition.executor, phase_bindings:transition.phase_bindings,
      });
      const currentDependencyFingerprint = await projectTransitionDependencyFingerprint({ transition_id:transition.id, requires:transition.requires || [] });
      const reconciliation = reconcileProjectTransitionChange(
        {
          transition_id:row.transition_id,
          definition_fingerprint:row.transition_revision_fingerprint,
          dependency_fingerprint:row.transition_dependency_fingerprint,
        },
        {
          transition_id:transition.id,
          definition_fingerprint:currentRevisionFingerprint,
          dependency_fingerprint:currentDependencyFingerprint,
        },
        {
          mutation_scope_unchanged:true,
          required_authority_valid:authority.repository === row.repository && authority.derivation === row.authority_derivation,
        },
      );
      if (reconciliation.may_continue_existing_authority !== true) {
        staleAuthority(row, authority, {
          reason:reconciliation.kind,
          expected_transition_definition_fingerprint:row.transition_definition_fingerprint,
          actual_transition_definition_fingerprint:currentTransitionFingerprint,
          expected_transition_revision_fingerprint:row.transition_revision_fingerprint,
          actual_transition_revision_fingerprint:currentRevisionFingerprint,
          expected_transition_dependency_fingerprint:row.transition_dependency_fingerprint,
          actual_transition_dependency_fingerprint:currentDependencyFingerprint,
        });
      }
      const semanticOwners = await store.getActiveLeasesForTransition(row.project_ref, row.transition_id, observedAtText);
      if (!Array.isArray(semanticOwners) || semanticOwners.length !== 1 || semanticOwners[0]?.lease_id !== row.lease_id) {
        fail('PROJECT_TRANSITION_LEASE_STALE', 'project transition lease no longer has unique semantic execution authority', {
          lease_ref:row.lease_id,
          project_ref:row.project_ref,
          transition_id:row.transition_id,
          active_lease_refs:Array.isArray(semanticOwners) ? semanticOwners.map((lease) => lease?.lease_id).filter(Boolean).sort() : [],
        });
      }
      graphRevisionChange = buildProjectGraphRevisionEvidence(
        { repository:row.repository, revision:row.authority_revision, derivation:row.authority_derivation },
        authority,
        [reconciliation],
      );
    }

    const slot = await store.getSlot(row.slot_key);
    if (!slot || slot.lease_id !== row.lease_id || instant(slot.expires_at, 'slot.expires_at') <= observedAt) {
      fail('PROJECT_TRANSITION_LEASE_STALE', 'project transition lease no longer owns its exclusive slot', { lease_ref:row.lease_id });
    }
    return { row, authority, graph, currentGraphFingerprint, graphRevisionChange };
  }

  async function acquire(input = {}) {
    const runId = text(input.run_id, 'run_id');
    const projectRef = text(input.project_ref, 'project_ref');
    const transitionId = text(input.transition_id, 'transition_id', 256);
    const idempotencyKey = text(input.idempotency_key, 'idempotency_key', 256);
    const seconds = leaseSeconds(input.lease_seconds);
    const acquireRequestHash = await sha256Text(canonicalJson({
      run_id:runId,
      project_ref:projectRef,
      transition_id:transitionId,
      lease_seconds:seconds,
    }));
    const prior = await store.getLeaseByAcquireIdempotency(idempotencyKey);
    if (prior) {
      if (prior.acquire_request_hash !== acquireRequestHash) {
        fail('PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT', 'project transition idempotency key was already used for different acquisition semantics', {
          idempotency_key:idempotencyKey,
        });
      }
      const verified = await currentLease(prior, { run_id:runId, project_ref:projectRef, transition_id:transitionId });
      return publicLease(prior, verified.authority, true, verified.graphRevisionChange);
    }

    const observedAtText = now();
    const observedAt = instant(observedAtText, 'now');
    const run = await store.getRun(runId);
    if (!run || run.status !== 'active' || instant(run.deadline_at, 'run.deadline_at') <= observedAt) {
      fail('PROJECT_TRANSITION_RUN_NOT_ACTIVE', 'project transition lease requires an active orchestration run', { run_id:runId });
    }

    const graph = await readProjectGraph(Object.freeze({ project_ref:projectRef }));
    if (!graph || graph.schema !== 'project-graph-authority-v1' || graph.project_ref !== projectRef) {
      fail('PROJECT_TRANSITION_AUTHORITY_INVALID', 'authoritative project graph does not match requested project', { project_ref:projectRef });
    }
    const authority = definitionAuthority(graph);
    const evaluated = evaluateProjectGraph(graph);
    const transition = evaluated.nodes.find((node) => node.id === transitionId) || null;
    if (!transition || transition.state !== 'READY') {
      fail('PROJECT_TRANSITION_NOT_READY', 'project transition is not READY in the authoritative graph', {
        project_ref:projectRef,
        transition_id:transitionId,
        state:transition?.state ?? null,
      });
    }
    const transitionDefinitionFingerprint = await projectTransitionDefinitionFingerprint(transition);
    const transitionRevisionFingerprint = await projectTransitionRevisionFingerprint({
      transition_id:transition.id, priority:transition.priority, executor:transition.executor, phase_bindings:transition.phase_bindings,
    });
    const transitionDependencyFingerprint = await projectTransitionDependencyFingerprint({ transition_id:transition.id, requires:transition.requires || [] });

    if (typeof store.getActiveLeasesForTransition === 'function') {
      const activeSemanticLeases = await store.getActiveLeasesForTransition(projectRef, transitionId, observedAtText);
      if (Array.isArray(activeSemanticLeases) && activeSemanticLeases.length > 0) {
        fail('PROJECT_TRANSITION_ALREADY_LEASED', 'project transition already has active execution authority', {
          project_ref:projectRef,
          transition_id:transitionId,
          revision:authority.revision,
          active_lease_refs:activeSemanticLeases.map((lease) => lease?.lease_id).filter(Boolean).sort(),
        });
      }
    }

    const key = slotKey(projectRef, transitionId);
    const existingSlot = await store.getSlot(key);
    if (existingSlot && instant(existingSlot.expires_at, 'slot.expires_at') > observedAt) {
      fail('PROJECT_TRANSITION_ALREADY_LEASED', 'project transition already has active execution authority', {
        project_ref:projectRef,
        transition_id:transitionId,
        revision:authority.revision,
      });
    }
    if (existingSlot) await store.deleteSlot(key, existingSlot.lease_id);

    const requestedExpiry = observedAt + seconds * 1000;
    const runDeadline = instant(run.deadline_at, 'run.deadline_at');
    const expiry = new Date(Math.min(requestedExpiry, runDeadline)).toISOString();
    const row = {
      lease_id:uuid(),
      subject:'project_transition',
      run_id:runId,
      project_ref:projectRef,
      transition_id:transitionId,
      repository:authority.repository,
      authority_revision:authority.revision,
      authority_derivation:authority.derivation,
      graph_fingerprint:await graphFingerprint(graph),
      transition_definition_fingerprint:transitionDefinitionFingerprint,
      transition_revision_fingerprint:transitionRevisionFingerprint,
      transition_dependency_fingerprint:transitionDependencyFingerprint,
      slot_key:key,
      status:'active',
      created_at:new Date(observedAt).toISOString(),
      expires_at:expiry,
      hard_expires_at:run.deadline_at,
      acquire_idempotency_key:idempotencyKey,
      acquire_request_hash:acquireRequestHash,
    };
    await store.insertLease(row);
    try {
      await store.insertSlot({ slot_key:key, lease_id:row.lease_id, expires_at:expiry });
    } catch (error) {
      await store.updateLease(row.lease_id, { status:'rejected', rejection_code:'PROJECT_TRANSITION_ALREADY_LEASED' });
      if (error?.code === 'UNIQUE_VIOLATION') {
        fail('PROJECT_TRANSITION_ALREADY_LEASED', 'project transition already has active execution authority', {
          project_ref:projectRef,
          transition_id:transitionId,
          revision:authority.revision,
        });
      }
      throw error;
    }
    return publicLease(row, authority, false);
  }

  async function requireLease(input = {}) {
    const leaseRef = text(input.lease_ref, 'lease_ref', 128);
    const lease = await currentLease(await store.getLease(leaseRef), {
      run_id:input.run_id ? text(input.run_id, 'run_id') : null,
      project_ref:input.project_ref ? text(input.project_ref, 'project_ref') : null,
      transition_id:input.transition_id ? text(input.transition_id, 'transition_id', 256) : null,
      repository:input.repository ? text(input.repository, 'repository', 256) : null,
    });
    return Object.freeze({
      ok:true,
      lease_ref:lease.row.lease_id,
      subject:'project_transition',
      run_id:lease.row.run_id,
      project_ref:lease.row.project_ref,
      transition_id:lease.row.transition_id,
      repository:lease.row.repository,
      authority:Object.freeze({ ...lease.authority }),
      graph_fingerprint:lease.row.graph_fingerprint,
      current_graph_fingerprint:lease.currentGraphFingerprint,
      graph_revision_change:lease.graphRevisionChange,
      transition_definition_fingerprint:lease.row.transition_definition_fingerprint,
      transition_revision_fingerprint:lease.row.transition_revision_fingerprint,
      transition_dependency_fingerprint:lease.row.transition_dependency_fingerprint,
    });
  }

  async function heartbeat(input = {}) {
    const leaseRef = text(input.lease_ref, 'lease_ref', 128);
    const runId = text(input.run_id, 'run_id');
    const idempotencyKey = text(input.idempotency_key, 'idempotency_key', 256);
    const seconds = heartbeatSeconds(input.extend_seconds);
    for (const method of ['getHeartbeatByIdempotency','getLatestCheckpoint','insertCheckpoint','listRecentHeartbeats','extendLeaseWithHeartbeat']) {
      if (typeof store[method] !== 'function') fail('PROJECT_TRANSITION_HEARTBEAT_STORAGE_UNAVAILABLE', 'project transition heartbeat persistence is unavailable', { method });
    }
    const row = await store.getLease(leaseRef);
    if (!row) fail('PROJECT_TRANSITION_LEASE_INVALID', 'project transition lease reference is unknown');
    if (row.run_id !== runId) fail('PROJECT_TRANSITION_LEASE_SCOPE_MISMATCH', 'project transition lease belongs to a different run', { lease_ref:leaseRef });
    const request = Object.freeze({ lease_ref:leaseRef, run_id:runId, extend_seconds:seconds, checkpoint:input.checkpoint ?? null });
    const requestHash = await sha256Text(canonicalJson(request));
    const prior = await store.getHeartbeatByIdempotency(leaseRef, idempotencyKey);
    if (prior) {
      if (prior.request_sha256 !== requestHash) fail('PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT', 'project transition heartbeat idempotency key was already used for different semantics', { lease_ref:leaseRef });
      return Object.freeze({ ok:true, schema:'project-transition-lease-heartbeat-v1', subject:'project_transition', lease_ref:leaseRef, run_id:runId, previous_expires_at:prior.previous_expires_at, expires_at:prior.new_expires_at, checkpoint_sha256:prior.progress_sha256, idempotent_replay:true });
    }
    const verified = await currentLease(row, { run_id:runId });
    const observedAtText = now();
    let checkpointRow = null;
    if (input.checkpoint) {
      const checkpointSha = await sha256Text(canonicalJson(input.checkpoint));
      checkpointRow = await store.insertCheckpoint(leaseRef, idempotencyKey, requestHash, input.checkpoint, checkpointSha, observedAtText);
    } else checkpointRow = await store.getLatestCheckpoint(leaseRef);
    if (!checkpointRow?.checkpoint_sha256) fail('PROJECT_TRANSITION_CHECKPOINT_REQUIRED', 'project transition heartbeat requires a durable progress checkpoint', { lease_ref:leaseRef });
    const progressSha = checkpointRow.checkpoint_sha256;
    const recent = await store.listRecentHeartbeats(leaseRef, 2);
    const sameProgress = recent.filter((entry) => entry.progress_sha256 === progressSha).length;
    if (sameProgress >= 2) fail('PROJECT_TRANSITION_NO_PROGRESS_HEARTBEAT', 'project transition lease cannot be extended repeatedly without materially advanced checkpoint progress', { lease_ref:leaseRef, progress_sha256:progressSha, same_progress_heartbeats:sameProgress });
    const run = await store.getRun(runId);
    if (!run || run.status !== 'active') fail('PROJECT_TRANSITION_RUN_NOT_ACTIVE', 'project transition lease requires an active orchestration run', { run_id:runId });
    const hardMs = instant(row.hard_expires_at, 'lease.hard_expires_at');
    const runCapMs = instant(run.deadline_at, 'run.deadline_at') - Number(run.settlement_reserve_seconds || 0) * 1000;
    const capMs = Math.min(hardMs, runCapMs);
    const desiredMs = Math.max(instant(row.expires_at, 'lease.expires_at'), instant(observedAtText, 'now') + seconds * 1000);
    const newExpiryMs = Math.min(desiredMs, capMs);
    if (!Number.isFinite(newExpiryMs) || newExpiryMs <= instant(row.expires_at, 'lease.expires_at')) fail('PROJECT_TRANSITION_HEARTBEAT_LIMIT_REACHED', 'project transition heartbeat cannot extend lease beyond its bounded execution horizon', { lease_ref:leaseRef, hard_expires_at:row.hard_expires_at, run_deadline_at:run.deadline_at, required_transition:'settle_before_more_work', required_command:'work.settle', checkpoint_sha256:progressSha, checkpoint_already_durable:true });
    const newExpiresAt = new Date(newExpiryMs).toISOString();
    const saved = await store.extendLeaseWithHeartbeat({ lease_id:leaseRef, slot_key:row.slot_key, idempotency_key:idempotencyKey, request_sha256:requestHash, progress_sha256:progressSha, previous_expires_at:row.expires_at, new_expires_at:newExpiresAt, created_at:observedAtText });
    return Object.freeze({ ok:true, schema:'project-transition-lease-heartbeat-v1', subject:'project_transition', lease_ref:leaseRef, run_id:runId, project_ref:row.project_ref, transition_id:row.transition_id, previous_expires_at:row.expires_at, expires_at:newExpiresAt, hard_expires_at:row.hard_expires_at, checkpoint_sha256:progressSha, heartbeat_count:Number(saved?.heartbeat_count || 0), authority:Object.freeze({ ...verified.authority }), graph_revision_change:verified.graphRevisionChange, idempotent_replay:false });
  }

  async function settle(input = {}) {
    const leaseRef = text(input.lease_ref, 'lease_ref', 128);
    const runId = text(input.run_id, 'run_id');
    const disposition = text(input.disposition, 'disposition', 32).toLowerCase();
    const idempotencyKey = text(input.idempotency_key, 'idempotency_key', 256);
    if (!new Set(['completed','blocked','requeue']).has(disposition)) {
      fail('PROJECT_TRANSITION_LEASE_REQUEST_INVALID', 'disposition must be completed, blocked, or requeue');
    }
    const row = await store.getLease(leaseRef);
    if (!row) fail('PROJECT_TRANSITION_LEASE_INVALID', 'project transition lease reference is unknown');
    if (row.status === 'settled') {
      if (row.settle_idempotency_key === idempotencyKey && row.disposition === disposition) {
        return Object.freeze({ ok:true, schema:'project-transition-lease-settlement-v1', lease_ref:row.lease_id, status:'settled', disposition, settled_at:row.settled_at, idempotent_replay:true });
      }
      fail('PROJECT_TRANSITION_LEASE_ALREADY_SETTLED', 'project transition lease was already settled by a different request', { lease_ref:row.lease_id });
    }
    const verified = await currentLease(row, { run_id:runId });
    const settledAt = now();
    const updated = await store.updateLease(row.lease_id, {
      status:'settled',
      disposition,
      settle_idempotency_key:idempotencyKey,
      settled_at:settledAt,
    });
    await store.deleteSlot(row.slot_key, row.lease_id);
    return Object.freeze({
      ok:true,
      schema:'project-transition-lease-settlement-v1',
      lease_ref:updated.lease_id,
      subject:'project_transition',
      run_id:updated.run_id,
      project_ref:updated.project_ref,
      transition_id:updated.transition_id,
      status:'settled',
      disposition,
      settled_at:settledAt,
      graph_revision_change:verified.graphRevisionChange,
      idempotent_replay:false,
    });
  }

  return Object.freeze({ acquire, require:requireLease, heartbeat, settle });
}

const BOOTSTRAP_PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const BOOTSTRAP_REPOSITORY = 'laurajoyhutchins/overcenter';
const BOOTSTRAP_DERIVATION = 'overcenter-project-graph-v1';
const BOOTSTRAP_TRANSITION_ID = 'register-project-graph-deriver';

function bootstrapFail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function bootstrapRunId(value) {
  const runId = typeof value === 'string' ? value.trim() : '';
  if (!runId || runId.length > 512) bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_INVALID', 'run_id is invalid', { field:'run_id' });
  return runId;
}

function bootstrapAuthority(graph) {
  if (!graph || graph.schema !== 'project-graph-authority-v1' || graph.project_ref !== BOOTSTRAP_PROJECT_REF) {
    bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_UNAVAILABLE', 'authoritative Overcenter project graph is unavailable');
  }
  const authority = definitionAuthority(graph);
  if (authority.repository !== BOOTSTRAP_REPOSITORY || authority.derivation !== BOOTSTRAP_DERIVATION) {
    bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_UNAVAILABLE', 'authoritative Overcenter graph derivation does not match bootstrap contract', {
      repository:authority.repository,
      derivation:authority.derivation,
    });
  }
  return authority;
}

function bootstrapResult({ outcome, leaseRef, settledAt, fingerprint, authority, evaluated }) {
  return Object.freeze({
    ok:true,
    schema:'project-graph-deriver-bootstrap-confirmation-v1',
    outcome,
    project_ref:BOOTSTRAP_PROJECT_REF,
    transition_id:BOOTSTRAP_TRANSITION_ID,
    transition_definition_fingerprint:fingerprint,
    lease_ref:leaseRef || null,
    settled_at:settledAt || null,
    authority:Object.freeze({ ...authority }),
    frontier:Object.freeze(evaluated.frontier.map((node) => node.id)),
  });
}

export function createProjectGraphDeriverBootstrapConfirmationService({ projectTransitions, readProjectGraph } = {}) {
  if (!projectTransitions || typeof projectTransitions.acquire !== 'function' || typeof projectTransitions.settle !== 'function') {
    throw new TypeError('projectTransitions is required');
  }
  if (typeof readProjectGraph !== 'function') throw new TypeError('readProjectGraph is required');

  async function confirm(input = {}) {
    const runId = bootstrapRunId(input.run_id);
    const graph = await readProjectGraph(Object.freeze({ project_ref:BOOTSTRAP_PROJECT_REF }));
    const authority = bootstrapAuthority(graph);
    const evaluated = evaluateProjectGraph(graph);
    const transition = evaluated.nodes.find((node) => node.id === BOOTSTRAP_TRANSITION_ID) || null;
    const definition = graph.nodes.find((node) => node.id === BOOTSTRAP_TRANSITION_ID) || null;
    if (!transition || !definition) {
      bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_UNAVAILABLE', 'graph-deriver bootstrap transition is missing from authoritative graph');
    }
    const fingerprint = await projectTransitionDefinitionFingerprint(definition);
    if (transition.state === 'DONE') {
      const observation = Array.isArray(graph?.authority?.observations)
        ? graph.authority.observations.find((entry) => entry?.kind === 'project_transition_confirmation'
          && entry.transition_id === BOOTSTRAP_TRANSITION_ID
          && entry.transition_definition_fingerprint === fingerprint
          && String(entry.disposition || '').toLowerCase() === 'completed')
        : null;
      if (!observation) {
        bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_NOT_CONFIRMED', 'bootstrap transition is DONE without a compatible normal confirmation receipt');
      }
      return bootstrapResult({
        outcome:'already_confirmed',
        leaseRef:observation?.provenance?.lease_ref || null,
        settledAt:observation?.provenance?.settled_at || null,
        fingerprint,
        authority,
        evaluated,
      });
    }
    if (transition.state !== 'READY') {
      bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_NOT_READY', 'graph-deriver bootstrap transition is not READY', { state:transition.state });
    }

    const identity = await sha256Text(canonicalJson({
      schema:'project-graph-deriver-bootstrap-confirmation-v1',
      run_id:runId,
      project_ref:BOOTSTRAP_PROJECT_REF,
      transition_id:BOOTSTRAP_TRANSITION_ID,
      authority_revision:authority.revision,
      transition_definition_fingerprint:fingerprint,
    }));
    const lease = await projectTransitions.acquire({
      run_id:runId,
      project_ref:BOOTSTRAP_PROJECT_REF,
      transition_id:BOOTSTRAP_TRANSITION_ID,
      lease_seconds:600,
      idempotency_key:`bootstrap-graph-deriver-acquire:${identity}`,
    });
    if (lease.transition_definition_fingerprint !== fingerprint) {
      bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_AUTHORITY_CHANGED', 'bootstrap transition definition changed during acquisition');
    }
    const settlement = await projectTransitions.settle({
      lease_ref:lease.lease_ref,
      run_id:runId,
      disposition:'completed',
      idempotency_key:`bootstrap-graph-deriver-settle:${identity}`,
    });

    const refreshed = await readProjectGraph(Object.freeze({ project_ref:BOOTSTRAP_PROJECT_REF }));
    const refreshedAuthority = bootstrapAuthority(refreshed);
    const refreshedDefinition = refreshed.nodes.find((node) => node.id === BOOTSTRAP_TRANSITION_ID) || null;
    if (!refreshedDefinition || await projectTransitionDefinitionFingerprint(refreshedDefinition) !== fingerprint) {
      bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_AUTHORITY_CHANGED', 'bootstrap transition definition changed before confirmation');
    }
    const refreshedEvaluation = evaluateProjectGraph(refreshed);
    const refreshedTransition = refreshedEvaluation.nodes.find((node) => node.id === BOOTSTRAP_TRANSITION_ID) || null;
    if (refreshedTransition?.state !== 'DONE') {
      bootstrapFail('PROJECT_BOOTSTRAP_CONFIRMATION_NOT_CONFIRMED', 'normal bootstrap settlement did not project DONE onto the authoritative graph', { state:refreshedTransition?.state ?? null });
    }
    return bootstrapResult({
      outcome:'confirmed',
      leaseRef:lease.lease_ref,
      settledAt:settlement.settled_at || null,
      fingerprint,
      authority:refreshedAuthority,
      evaluated:refreshedEvaluation,
    });
  }

  return Object.freeze({ confirm });
}

export function statusForProjectGraphDeriverBootstrapConfirmationError(error) {
  const code = String(error?.code || '');
  if (code === 'PROJECT_BOOTSTRAP_CONFIRMATION_INVALID') return 400;
  if (code === 'PROJECT_GRAPH_READER_UNAVAILABLE' || code.endsWith('_UNAVAILABLE')) return 503;
  if (code.startsWith('PROJECT_BOOTSTRAP_CONFIRMATION_') || code.startsWith('PROJECT_TRANSITION_') || code.startsWith('PROJECT_GRAPH_')) return 409;
  return null;
}