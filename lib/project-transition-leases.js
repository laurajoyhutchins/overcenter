import { canonicalJson, sha256Text } from './canonical-json.js';
import { evaluateProjectGraph } from './project-graph.js';

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

function slotKey(projectRef, revision, transitionId) {
  return `project_transition:${projectRef}:${revision}:${transitionId}`;
}

function publicLease(row, authority) {
  return Object.freeze({
    ok:true,
    schema:'project-transition-lease-v1',
    lease_ref:row.lease_id,
    subject:'project_transition',
    run_id:row.run_id,
    project_ref:row.project_ref,
    transition_id:row.transition_id,
    authority:Object.freeze({ ...authority }),
    expires_at:row.expires_at,
    ownership_protocol:'project-transition-slot-v1',
  });
}

export function createProjectTransitionLeaseService({ store, readProjectGraph, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() } = {}) {
  if (!store || typeof store.getRun !== 'function' || typeof store.getLease !== 'function' || typeof store.getSlot !== 'function'
      || typeof store.insertLease !== 'function' || typeof store.insertSlot !== 'function' || typeof store.updateLease !== 'function'
      || typeof store.deleteSlot !== 'function') {
    throw new TypeError('project transition lease store is incomplete');
  }
  if (typeof readProjectGraph !== 'function') throw new TypeError('readProjectGraph is required');

  async function currentLease(row, input = {}) {
    if (!row) fail('PROJECT_TRANSITION_LEASE_INVALID', 'project transition lease reference is unknown');
    const observedAt = instant(now(), 'now');
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
    const fingerprint = await graphFingerprint(graph);
    if (authority.repository !== row.repository || authority.revision !== row.authority_revision
        || authority.derivation !== row.authority_derivation || fingerprint !== row.graph_fingerprint) {
      fail('PROJECT_TRANSITION_AUTHORITY_STALE', 'project transition authority changed after lease acquisition', {
        lease_ref:row.lease_id,
        expected_revision:row.authority_revision,
        actual_revision:authority.revision,
      });
    }
    const slot = await store.getSlot(row.slot_key);
    if (!slot || slot.lease_id !== row.lease_id || instant(slot.expires_at, 'slot.expires_at') <= observedAt) {
      fail('PROJECT_TRANSITION_LEASE_STALE', 'project transition lease no longer owns its exclusive slot', { lease_ref:row.lease_id });
    }
    return { row, authority, graph };
  }

  async function acquire(input = {}) {
    const runId = text(input.run_id, 'run_id');
    const projectRef = text(input.project_ref, 'project_ref');
    const transitionId = text(input.transition_id, 'transition_id', 256);
    text(input.idempotency_key, 'idempotency_key', 256);
    const seconds = leaseSeconds(input.lease_seconds);
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

    const key = slotKey(projectRef, authority.revision, transitionId);
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
      slot_key:key,
      status:'active',
      created_at:new Date(observedAt).toISOString(),
      expires_at:expiry,
      hard_expires_at:run.deadline_at,
      acquire_idempotency_key:input.idempotency_key,
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
    return publicLease(row, authority);
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
    });
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
    await currentLease(row, { run_id:runId });
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
      idempotent_replay:false,
    });
  }

  return Object.freeze({ acquire, require:requireLease, settle });
}