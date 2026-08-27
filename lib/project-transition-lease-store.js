import { sha256Text } from './canonical-json.js';

const IDEMPOTENCY_PREFIX = 'project-transition:';
const MUTATION_GATE = 'lane:repo-implementation';

function object(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function required(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw Object.assign(new Error(`${field} is required`), { code:'PROJECT_TRANSITION_LEASE_PERSISTENCE_INVALID' });
  return text;
}

export async function prepareProjectTransitionLeasePersistence(row, options = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw Object.assign(new Error('project transition lease row must be an object'), { code:'PROJECT_TRANSITION_LEASE_PERSISTENCE_INVALID' });
  }
  const capabilityToken = required(options.capabilityToken, 'capabilityToken');
  const leaseId = required(row.lease_id, 'lease_id');
  const slotKey = required(row.slot_key, 'slot_key');
  const runId = required(row.run_id, 'run_id');
  const projectRef = required(row.project_ref, 'project_ref');
  const transitionId = required(row.transition_id, 'transition_id');
  const repository = required(row.repository, 'repository');
  const authorityRevision = required(row.authority_revision, 'authority_revision');
  const authorityDerivation = required(row.authority_derivation, 'authority_derivation');
  const graphFingerprint = required(row.graph_fingerprint, 'graph_fingerprint');
  const acquireIdempotencyKey = required(row.acquire_idempotency_key, 'acquire_idempotency_key');
  const acquireRequestHash = required(row.acquire_request_hash, 'acquire_request_hash');

  const projectTransition = Object.freeze({
    project_ref:projectRef,
    transition_id:transitionId,
    repository,
    authority_revision:authorityRevision,
    authority_derivation:authorityDerivation,
    graph_fingerprint:graphFingerprint,
    slot_key:slotKey,
  });
  const claimReceipt = Object.freeze({
    schema:'project-transition-lease-claim-v1',
    subject:'project_transition',
    project_transition:projectTransition,
    execution_fingerprint:graphFingerprint,
  });
  const claimRequest = Object.freeze({
    schema:'project-transition-lease-acquire-v1',
    subject:'project_transition',
    run_id:runId,
    project_ref:projectRef,
    transition_id:transitionId,
    authority_revision:authorityRevision,
    acquire_request_hash:acquireRequestHash,
  });

  return Object.freeze({
    lease_id:leaseId,
    work_ref:slotKey,
    gate:MUTATION_GATE,
    run_id:runId,
    lease_token:capabilityToken,
    token_hash:await sha256Text(capabilityToken),
    claim_idempotency_key:`${IDEMPOTENCY_PREFIX}${acquireIdempotencyKey}`,
    claim_request_hash:acquireRequestHash,
    claim_request:claimRequest,
    status:row.status || 'active',
    created_at:required(row.created_at, 'created_at'),
    expires_at:required(row.expires_at, 'expires_at'),
    hard_expires_at:required(row.hard_expires_at, 'hard_expires_at'),
    previous_state:'PROJECT_TRANSITION',
    previous_state_id:'project_transition',
    previous_lane:MUTATION_GATE,
    previous_lane_id:'project_transition',
    claim_revision:authorityRevision,
    active_revision:authorityRevision,
    claim_receipt:claimReceipt,
  });
}

export function restoreProjectTransitionLease(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const claimReceipt = object(row.claim_receipt);
  if (claimReceipt?.subject !== 'project_transition') return null;
  const subject = object(claimReceipt.project_transition);
  if (!subject) return null;
  const claimKey = String(row.claim_idempotency_key || '');
  if (!claimKey.startsWith(IDEMPOTENCY_PREFIX)) return null;
  const settlePlan = object(row.settle_plan);
  return Object.freeze({
    lease_id:String(row.lease_id || ''),
    subject:'project_transition',
    run_id:String(row.run_id || ''),
    project_ref:String(subject.project_ref || ''),
    transition_id:String(subject.transition_id || ''),
    repository:String(subject.repository || ''),
    authority_revision:String(subject.authority_revision || ''),
    authority_derivation:String(subject.authority_derivation || ''),
    graph_fingerprint:String(subject.graph_fingerprint || ''),
    slot_key:String(subject.slot_key || row.work_ref || ''),
    status:String(row.status || ''),
    created_at:row.created_at,
    expires_at:row.expires_at,
    hard_expires_at:row.hard_expires_at,
    acquire_idempotency_key:claimKey.slice(IDEMPOTENCY_PREFIX.length),
    acquire_request_hash:String(row.claim_request_hash || ''),
    settle_idempotency_key:row.settle_idempotency_key || null,
    disposition:settlePlan?.disposition || null,
    settled_at:row.settled_at || null,
  });
}

export const projectTransitionLeasePersistence = Object.freeze({
  idempotency_prefix:IDEMPOTENCY_PREFIX,
  mutation_gate:MUTATION_GATE,
});