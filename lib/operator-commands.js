import { db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { normalizeLeaseRef, workLeaseConfig } from 'lib/work-leases.js';

function text(value, name, max = 512) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > max) {
    const error = new Error(`${name} is invalid`);
    error.code = 'REQUEST_INVALID';
    error.details = { field: name };
    throw error;
  }
  return out;
}

function optionalText(value, name, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, name, max);
}

function evidence(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50) {
    const error = new Error('evidence must be an array of at most 50 items');
    error.code = 'REQUEST_INVALID';
    throw error;
  }
  return value.map((item, index) => ({
    kind: text(item?.kind, `evidence[${index}].kind`, 128),
    ref: text(item?.ref, `evidence[${index}].ref`, 2048),
  }));
}

function authorityRevisions(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 25) {
    const error = new Error('authority_revisions must be an array of at most 25 items');
    error.code = 'REQUEST_INVALID';
    throw error;
  }
  return value.map((item, index) => ({
    kind: text(item?.kind, `authority_revisions[${index}].kind`, 128),
    ref: text(item?.ref, `authority_revisions[${index}].ref`, 1024),
    revision: text(item?.revision, `authority_revisions[${index}].revision`, 1024),
  }));
}

export async function semanticIdempotencyKey(command, semanticIdentity) {
  const digest = await sha256Text(canonicalJson({ command, semantic_identity: semanticIdentity }));
  return `auto:${command}:${digest}`;
}

export function checkpointFromSemantic(args = {}) {
  return {
    schema: workLeaseConfig.checkpoint_schema,
    phase: text(args.phase, 'phase', 128),
    next_action_kind: text(args.next_action ?? args.next_action_kind, 'next_action', 128),
    candidate: args.candidate ?? null,
    completed: evidence(args.completed),
    evidence: evidence(args.evidence),
    authority_revisions: authorityRevisions(args.authority_revisions),
  };
}

export async function leaseIdentity(leaseToken, dbBinding = db) {
  const token = text(leaseToken, 'lease_token', 256);
  const tokenHash = await sha256Text(token);
  const result = await dbBinding.query(
    `SELECT lease_id, run_id, work_ref, gate, status, expires_at
       FROM work_leases
      WHERE token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );
  const lease = result.rows[0] || null;
  if (!lease) {
    const error = new Error('lease token is not recognized');
    error.code = 'LEASE_INVALID';
    throw error;
  }
  return lease;
}

export async function leaseIdentityByRef(leaseRef, dbBinding = db) {
  const ref = normalizeLeaseRef(leaseRef);
  const result = await dbBinding.query(
    `SELECT lease_id, run_id, work_ref, gate, status, expires_at
       FROM work_leases
      WHERE lease_id = $1
      LIMIT 1`,
    [ref],
  );
  const lease = result.rows[0] || null;
  if (!lease) {
    const error = new Error('lease reference is invalid');
    error.code = 'LEASE_INVALID';
    throw error;
  }
  return lease;
}

async function claimAttemptIdentity(request, dbBinding = db) {
  const scopedByLane = Boolean(request.expected_lane);
  const prior = await dbBinding.query(
    scopedByLane
      ? `SELECT claim_idempotency_key, status
           FROM work_leases
          WHERE run_id = $1 AND work_ref = $2 AND gate = $3
          ORDER BY created_at DESC
          LIMIT 1`
      : `SELECT claim_idempotency_key, status
           FROM work_leases
          WHERE run_id = $1 AND work_ref = $2
          ORDER BY created_at DESC
          LIMIT 1`,
    scopedByLane
      ? [request.run_id, request.work_ref, request.expected_lane]
      : [request.run_id, request.work_ref],
  );
  const latest = prior.rows[0] || null;
  if (latest && ['claiming','active'].includes(latest.status) && String(latest.claim_idempotency_key || '').startsWith('auto:work.claim:')) {
    return { reuse_key: latest.claim_idempotency_key, attempt: null };
  }
  const count = await dbBinding.query(
    scopedByLane
      ? `SELECT count(*)::int AS count
           FROM work_leases
          WHERE run_id = $1 AND work_ref = $2 AND gate = $3`
      : `SELECT count(*)::int AS count
           FROM work_leases
          WHERE run_id = $1 AND work_ref = $2`,
    scopedByLane
      ? [request.run_id, request.work_ref, request.expected_lane]
      : [request.run_id, request.work_ref],
  );
  return { reuse_key: null, attempt: Number(count.rows[0]?.count || 0) + 1 };
}

export async function canonicalClaimCommand(args = {}, dbBinding = db) {
  const leaseSeconds = args.lease_seconds == null ? workLeaseConfig.default_lease_seconds : Number(args.lease_seconds);
  const observedRevision = args.observed_revision ?? args.expected_revision;
  if (observedRevision == null) {
    const error = new Error('observed_revision is required');
    error.code = 'REQUEST_INVALID';
    error.details = { field: 'observed_revision', observation_contract: 'authoritative-revision-v1' };
    throw error;
  }

  const request = {
    work_ref: text(args.work_ref, 'work_ref', 128),
    run_id: text(args.run_id, 'run_id', 512),
    expected_revision: text(observedRevision, 'observed_revision', 256),
    expected_state: null,
    expected_lane: null,
    lease_seconds: leaseSeconds,
  };
  const identity = await claimAttemptIdentity(request, dbBinding);
  request.idempotency_key = identity.reuse_key || await semanticIdempotencyKey('work.claim', {
    run_id: request.run_id,
    work_ref: request.work_ref,
    gate: request.expected_lane || null,
    attempt: identity.attempt,
  });
  return request;
}

export async function canonicalCheckpointCommand(args = {}, dbBinding = db) {
  const lease = await leaseIdentity(args.lease_token, dbBinding);
  const checkpoint = checkpointFromSemantic(args);
  const semantic = { lease_id: lease.lease_id, checkpoint };
  return {
    lease_token: args.lease_token,
    run_id: lease.run_id,
    checkpoint,
    idempotency_key: await semanticIdempotencyKey('work.checkpoint', semantic),
  };
}

export async function canonicalHeartbeatCommand(args = {}, dbBinding = db) {
  const lease = await leaseIdentity(args.lease_token, dbBinding);
  const hasCheckpoint = args.phase != null || args.next_action != null || args.next_action_kind != null || args.candidate != null || args.completed != null || args.evidence != null || args.authority_revisions != null;
  const checkpoint = hasCheckpoint ? checkpointFromSemantic(args) : null;
  const extendSeconds = args.extend_seconds == null ? workLeaseConfig.default_heartbeat_seconds : Number(args.extend_seconds);
  const semantic = { lease_id: lease.lease_id, extend_seconds: extendSeconds, checkpoint };
  return {
    lease_token: args.lease_token,
    run_id: lease.run_id,
    extend_seconds: extendSeconds,
    checkpoint,
    idempotency_key: await semanticIdempotencyKey('work.heartbeat', semantic),
  };
}

export function settlementFromSemantic(args = {}) {
  if (args.next_state != null || args.next_lane != null) {
    const error = new Error('successor state and lane are selected by Overcenter');
    error.code = 'REQUEST_INVALID';
    throw error;
  }
  if (args.lifecycle_facts != null && (!args.lifecycle_facts || typeof args.lifecycle_facts !== 'object' || Array.isArray(args.lifecycle_facts))) {
    const error = new Error('lifecycle_facts must be an object');
    error.code = 'REQUEST_INVALID';
    throw error;
  }
  return {
    disposition: text(args.disposition, 'disposition', 64),
    evidence: evidence(args.evidence),
    reason: optionalText(args.reason, 'reason', 2000),
    promotion_condition: optionalText(args.promotion_condition, 'promotion_condition', 2000),
    requeue_class: optionalText(args.requeue_class, 'requeue_class', 128),
    operating_condition: optionalText(args.operating_condition, 'operating_condition', 64),
    continuation: args.continuation ?? null,
    lifecycle_facts: args.lifecycle_facts ?? null,
  };
}

export async function canonicalSettleCommand(args = {}, dbBinding = db) {
  const lease = await leaseIdentity(args.lease_token, dbBinding);
  return {
    lease_token: args.lease_token,
    run_id: lease.run_id,
    ...settlementFromSemantic(args),
    idempotency_key: await semanticIdempotencyKey('work.settle', { lease_id: lease.lease_id }),
  };
}

export async function canonicalCheckpointCommandByRef(args = {}, dbBinding = db) {
  const lease = await leaseIdentityByRef(args.lease_ref, dbBinding);
  const checkpoint = checkpointFromSemantic(args);
  return {
    lease_ref: lease.lease_id,
    run_id: lease.run_id,
    checkpoint,
    idempotency_key: await semanticIdempotencyKey('work.checkpoint', { lease_id: lease.lease_id, checkpoint }),
  };
}

export async function canonicalHeartbeatCommandByRef(args = {}, dbBinding = db) {
  const lease = await leaseIdentityByRef(args.lease_ref, dbBinding);
  const hasCheckpoint = args.phase != null || args.next_action != null || args.next_action_kind != null || args.candidate != null || args.completed != null || args.evidence != null || args.authority_revisions != null;
  const checkpoint = hasCheckpoint ? checkpointFromSemantic(args) : null;
  const extendSeconds = args.extend_seconds == null ? workLeaseConfig.default_heartbeat_seconds : Number(args.extend_seconds);
  return {
    lease_ref: lease.lease_id,
    run_id: lease.run_id,
    extend_seconds: extendSeconds,
    checkpoint,
    idempotency_key: await semanticIdempotencyKey('work.heartbeat', { lease_id: lease.lease_id, extend_seconds: extendSeconds, checkpoint }),
  };
}

export async function canonicalSettleCommandByRef(args = {}, dbBinding = db) {
  const lease = await leaseIdentityByRef(args.lease_ref, dbBinding);
  return {
    lease_ref: lease.lease_id,
    run_id: lease.run_id,
    ...settlementFromSemantic(args),
    idempotency_key: await semanticIdempotencyKey('work.settle', { lease_id: lease.lease_id }),
  };
}

export function canonicalHorizonCommand(args = {}) {
  if (!Array.isArray(args.candidates)) return { run_id: args.run_id, candidates: args.candidates };
  return {
    run_id: args.run_id,
    candidates: args.candidates.map((candidate) => ({
      work_ref: candidate.work_ref,
      expected_state: candidate.observed_state ?? candidate.expected_state,
      expected_lane: candidate.observed_lane ?? candidate.expected_lane,
      selection_reason: candidate.selection_reason || 'agent_selected',
    })),
  };
}

export function canonicalFinishCommand(args = {}) {
  const aliases = { clean_stop: 'clean-stop', no_work: 'no-work' };
  return { ...args, disposition: aliases[args.disposition] || args.disposition };
}