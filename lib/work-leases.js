import { api, db } from 'hatchable';
import { canonicalJson, sha256Text } from './canonical-json.js';

const PROJECT = 'Portfolio Orchestration';
const ACTIVE_STATE = 'In Progress';
const EXECUTABLE_STATE = 'Todo';
const DEFAULT_LEASE_SECONDS = 1800;
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 3600;
const EXECUTION_LANES = new Set([
  'lane:repo-implementation',
  'lane:source-implementation',
  'lane:verification',
  'lane:integration',
]);
const SUCCESSOR = Object.freeze({
  'lane:repo-implementation': { state: 'Todo', lane: 'lane:verification' },
  'lane:source-implementation': { state: 'Todo', lane: 'lane:verification' },
  'lane:verification': { state: 'Todo', lane: 'lane:integration' },
  'lane:integration': { state: 'Done', lane: 'lane:integration' },
});
const COMPLETED_TRANSITIONS = Object.freeze({
  'lane:repo-implementation': new Set(['Todo|lane:verification']),
  'lane:source-implementation': new Set(['Todo|lane:verification']),
  'lane:verification': new Set([
    'Todo|lane:integration',
    'Todo|lane:repo-implementation',
    'Todo|lane:source-implementation',
  ]),
  'lane:integration': new Set([
    'Done|lane:integration',
    'Todo|lane:verification',
    'Todo|lane:repo-implementation',
    'Todo|lane:source-implementation',
  ]),
});
const DISPOSITIONS = new Set(['completed', 'requeue', 'blocked']);

function err(code, message, details = null) {
  const e = new Error(message);
  e.code = code;
  e.details = details;
  return e;
}

function requiredString(value, name, max = 512) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw err('REQUEST_INVALID', `${name} is invalid`, { field: name });
  return text;
}

function optionalString(value, name, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(String(value), name, max);
}

function normalizeLane(value) {
  if (!value) return null;
  const text = String(value).trim();
  return text.startsWith('lane:') ? text : `lane:${text}`;
}

function laneOf(issue) {
  const lanes = (issue.labels || []).filter(label => String(label.name || '').startsWith('lane:'));
  return lanes.length === 1 ? lanes[0] : null;
}

function stateByName(issue, name) {
  return (issue.teamStates || []).find(state => state.name === name) || null;
}

function labelByName(issue, name) {
  return (issue.teamLabels || []).find(label => label.name === name) || null;
}

function isExecutable(issue) {
  const lane = laneOf(issue);
  return issue.project?.name === PROJECT
    && issue.archivedAt == null
    && issue.state?.type === 'unstarted'
    && lane
    && EXECUTION_LANES.has(lane.name);
}

function parseField(description, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(description || '').match(new RegExp(`^\\*?\\*?${escaped}\\*?\\*?\\s*:\\s*(.+)$`, 'mi'));
  return match ? match[1].trim() : null;
}

function snapshot(issue) {
  return {
    title: issue.title,
    description: issue.description || '',
    project: issue.project?.name || null,
    repository: parseField(issue.description, 'Repository'),
    authority: parseField(issue.description, 'Authority') || parseField(issue.description, 'GitHub authority'),
    exact_coordinate: parseField(issue.description, 'Exact coordinate'),
    acceptance: parseField(issue.description, 'Acceptance') || parseField(issue.description, 'Lane exit'),
    owner_impact: parseField(issue.description, 'Owner impact'),
    relations: (issue.relations || []).map(r => ({
      type: r.type,
      work_ref: r.relatedIssue?.identifier || null,
      title: r.relatedIssue?.title || null,
    })),
  };
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function defaultTokenFactory() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `wlt_${base64url(bytes)}`;
}

function normalizeEvidence(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw err('REQUEST_INVALID', 'evidence must be an array of at most 50 items');
  return value.map((item, index) => ({
    kind: requiredString(item?.kind, `evidence[${index}].kind`, 128),
    ref: requiredString(item?.ref, `evidence[${index}].ref`, 1024),
  }));
}

function normalizeClaimRequest(input) {
  const leaseSeconds = input?.lease_seconds == null ? DEFAULT_LEASE_SECONDS : Number(input.lease_seconds);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < MIN_LEASE_SECONDS || leaseSeconds > MAX_LEASE_SECONDS) {
    throw err('REQUEST_INVALID', `lease_seconds must be an integer from ${MIN_LEASE_SECONDS} to ${MAX_LEASE_SECONDS}`);
  }
  return {
    work_ref: requiredString(input?.work_ref, 'work_ref', 128),
    run_id: requiredString(input?.run_id, 'run_id', 512),
    expected_state: optionalString(input?.expected_state, 'expected_state', 128),
    expected_lane: normalizeLane(optionalString(input?.expected_lane, 'expected_lane', 128)),
    lease_seconds: leaseSeconds,
    idempotency_key: requiredString(input?.idempotency_key, 'idempotency_key', 512),
  };
}

function normalizeSettleRequest(input) {
  const disposition = requiredString(input?.disposition, 'disposition', 32).toLowerCase();
  if (!DISPOSITIONS.has(disposition)) throw err('REQUEST_INVALID', 'disposition must be completed, requeue, or blocked');
  const reason = optionalString(input?.reason, 'reason', 2000);
  const promotion = optionalString(input?.promotion_condition, 'promotion_condition', 2000);
  if (disposition === 'blocked' && (!reason || !promotion)) {
    throw err('REQUEST_INVALID', 'blocked settlement requires reason and promotion_condition');
  }
  const nextState = optionalString(input?.next_state, 'next_state', 128);
  const nextLane = normalizeLane(optionalString(input?.next_lane, 'next_lane', 128));
  if ((nextState || nextLane) && disposition !== 'completed') {
    throw err('REQUEST_INVALID', 'next_state and next_lane are allowed only for completed settlement');
  }
  if ((nextState && !nextLane) || (!nextState && nextLane)) {
    throw err('REQUEST_INVALID', 'next_state and next_lane must be provided together');
  }
  return {
    lease_token: requiredString(input?.lease_token, 'lease_token', 256),
    disposition,
    evidence: normalizeEvidence(input?.evidence),
    reason,
    promotion_condition: promotion,
    next_state: nextState,
    next_lane: nextLane,
    idempotency_key: requiredString(input?.idempotency_key, 'idempotency_key', 512),
  };
}

function blockedDescription(description, reason, promotion) {
  const marker = '\n\n## Execution blocker\n';
  const base = String(description || '').split(marker)[0].trimEnd();
  return `${base}${marker}\nBlocked: ${reason}\n\nPromotion condition: ${promotion}`;
}

function settlementPlan(lease, request, issue) {
  if (request.disposition === 'requeue') {
    return { state: lease.previous_state, lane: lease.previous_lane, description: null, evidence: request.evidence };
  }
  if (request.disposition === 'blocked') {
    return {
      state: 'Backlog',
      lane: lease.previous_lane,
      description: blockedDescription(issue.description, request.reason, request.promotion_condition),
      evidence: request.evidence,
    };
  }
  const successor = SUCCESSOR[lease.gate];
  if (!successor) throw err('NON_EXECUTABLE_WORK', `No configured successor exists for ${lease.gate}`);
  const target = request.next_state && request.next_lane
    ? { state: request.next_state, lane: request.next_lane }
    : successor;
  const allowed = COMPLETED_TRANSITIONS[lease.gate];
  if (!allowed?.has(`${target.state}|${target.lane}`)) {
    throw err('INVALID_SUCCESSOR', 'completed settlement successor is not valid for the current gate', {
      gate: lease.gate,
      next_state: target.state,
      next_lane: target.lane,
    });
  }
  return { ...target, description: null, evidence: request.evidence };
}

function issueMatches(issue, { state, lane }) {
  return issue.state?.name === state && laneOf(issue)?.name === lane;
}

function publicLease(lease) {
  if (!lease) return null;
  return {
    lease_id: lease.lease_id,
    work_ref: lease.work_ref,
    gate: lease.gate,
    run_id: lease.run_id,
    status: lease.status,
    created_at: lease.created_at,
    expires_at: lease.expires_at,
  };
}

export function createWorkLeaseService({ store, authoritative, now = () => new Date().toISOString(), tokenFactory = defaultTokenFactory } = {}) {
  if (!store || !authoritative) throw new TypeError('store and authoritative are required');

  async function reconcileExpired(workRef, gate) {
    const slot = await store.getSlot(workRef, gate);
    if (!slot || Date.parse(slot.expires_at) > Date.parse(now())) return null;
    const lease = await store.getLeaseById(slot.lease_id);
    if (!lease) {
      await store.releaseSlot(workRef, gate, slot.lease_id);
      return { restored: false, reason: 'MISSING_LEASE' };
    }
    let current = await authoritative.getIssue(workRef);
    let restored = false;
    let reason = 'AUTHORITATIVE_STATE_CHANGED';
    if (lease.status === 'active'
      && current.updatedAt === lease.active_revision
      && issueMatches(current, { state: ACTIVE_STATE, lane: lease.gate })) {
      current = await authoritative.transition({
        issue: current,
        expectedRevision: current.updatedAt,
        expectedState: ACTIVE_STATE,
        expectedLane: lease.gate,
        targetState: lease.previous_state,
        targetLane: lease.previous_lane,
      });
      restored = true;
      reason = 'RESTORED_PREVIOUS_EXECUTABLE_STATE';
    }
    await store.markExpired(lease.lease_id, { restored, reason, observed_revision: current.updatedAt, reconciled_at: now() });
    await store.releaseSlot(workRef, gate, lease.lease_id);
    return { restored, reason };
  }

  async function recoverClaimReplay(existing, requestHash) {
    if (existing.claim_request_hash !== requestHash) throw err('IDEMPOTENCY_CONFLICT', 'idempotency_key was already used for a different claim request');
    if (existing.status === 'settled') throw err('LEASE_ALREADY_SETTLED', 'the lease from this claim was already settled');
    if (existing.status === 'expired') throw err('LEASE_EXPIRED', 'the lease from this claim has expired');
    if (existing.status === 'invalidated') throw err('WORK_STATE_CHANGED', 'the authoritative work item changed after claim');
    if (existing.status === 'rejected') {
      const rejection = existing.reconciliation || {};
      throw err(rejection.rejection_code || 'ALREADY_CLAIMED', 'the original claim request was rejected', rejection.rejection_details || null);
    }
    if (existing.claim_receipt) return { ...existing.claim_receipt, idempotent_replay: true };
    if (existing.status === 'claiming') {
      const slot = await store.getSlot(existing.work_ref, existing.gate);
      const issue = await authoritative.getIssue(existing.work_ref);
      if (slot?.lease_id === existing.lease_id && issueMatches(issue, { state: ACTIVE_STATE, lane: existing.gate })) {
        const receipt = {
          ok: true,
          work_ref: existing.work_ref,
          lease_token: existing.lease_token,
          lease_id: existing.lease_id,
          expires_at: existing.expires_at,
          previous_state: existing.previous_state,
          current_state: issue.state.name,
          lane: existing.gate,
          authoritative_revision: issue.updatedAt,
          idempotent_replay: true,
          snapshot: snapshot(issue),
        };
        await store.activateLease(existing.lease_id, issue.updatedAt, receipt);
        return receipt;
      }
    }
    throw err('CLAIM_INDETERMINATE', 'the original claim has no recoverable success receipt');
  }

  async function claim(input) {
    const request = normalizeClaimRequest(input);
    const requestHash = await sha256Text(canonicalJson(request));
    const prior = await store.getClaimByIdempotency(request.idempotency_key);
    if (prior) return recoverClaimReplay(prior, requestHash);

    let issue = await authoritative.getIssue(request.work_ref);
    let lane = laneOf(issue);
    if (!lane) throw err('NON_EXECUTABLE_WORK', 'work item must have exactly one lane label');
    const initialSlot = await store.getSlot(request.work_ref, lane.name);
    if (initialSlot && Date.parse(initialSlot.expires_at) > Date.parse(now())) {
      throw err('ALREADY_CLAIMED', 'another unexpired lease owns this work item', {
        work_ref: request.work_ref,
        expires_at: initialSlot.expires_at,
      });
    }

    // Preconditions describe the authoritative state the caller actually observed.
    // Check them before expired-lease reconciliation mutates transient In Progress
    // back to the prior executable state.
    if (request.expected_state && issue.state?.name !== request.expected_state) {
      throw err('STATE_MISMATCH', 'authoritative state did not match expected_state', { expected_state: request.expected_state, actual_state: issue.state?.name || null });
    }
    if (request.expected_lane && lane?.name !== request.expected_lane) {
      throw err('LANE_MISMATCH', 'authoritative lane did not match expected_lane', { expected_lane: request.expected_lane, actual_lane: lane?.name || null });
    }

    const expiredReconciliation = await reconcileExpired(request.work_ref, lane.name);
    issue = await authoritative.getIssue(request.work_ref);
    lane = laneOf(issue);

    if (request.expected_lane && lane?.name !== request.expected_lane) {
      throw err('LANE_MISMATCH', 'authoritative lane changed during claim reconciliation', { expected_lane: request.expected_lane, actual_lane: lane?.name || null });
    }

    // Legacy/pre-adoption runs may have left Linear in transient In Progress with
    // no lease record at all. Under the adopted protocol, In Progress without a
    // live Hatchable slot carries no execution authority. A caller that just
    // observed that exact state may repair it optimistically to Todo, then claim
    // normally. The Linear revision fence prevents overwriting a concurrent edit.
    let orphanRecovered = false;
    if (request.expected_state === ACTIVE_STATE && issue.state?.name === ACTIVE_STATE) {
      const postReconcileSlot = await store.getSlot(request.work_ref, lane.name);
      if (!postReconcileSlot) {
        issue = await authoritative.transition({
          issue,
          expectedRevision: issue.updatedAt,
          expectedState: ACTIVE_STATE,
          expectedLane: lane.name,
          targetState: EXECUTABLE_STATE,
          targetLane: lane.name,
        });
        lane = laneOf(issue);
        orphanRecovered = true;
      }
    }

    // Reconciliation may intentionally restore a truthfully observed In Progress
    // item to its prior executable state, either from an expired lease or from an
    // orphaned pre-lease transient state. Every other post-reconcile change must
    // still satisfy the caller's optimistic preconditions.
    if (request.expected_state
      && !(request.expected_state === ACTIVE_STATE && (expiredReconciliation?.restored || orphanRecovered))
      && issue.state?.name !== request.expected_state) {
      throw err('STATE_MISMATCH', 'authoritative state changed during claim reconciliation', { expected_state: request.expected_state, actual_state: issue.state?.name || null });
    }
    if (request.expected_lane && lane?.name !== request.expected_lane) {
      throw err('LANE_MISMATCH', 'authoritative lane changed during claim reconciliation', { expected_lane: request.expected_lane, actual_lane: lane?.name || null });
    }
    if (!isExecutable(issue)) {
      throw err('NON_EXECUTABLE_WORK', 'work item is not currently executable', { actual_state: issue.state?.name || null, actual_lane: lane?.name || null, project: issue.project?.name || null });
    }

    const createdAt = now();
    const expiresAt = new Date(Date.parse(createdAt) + request.lease_seconds * 1000).toISOString();
    const leaseToken = tokenFactory();
    const tokenHash = await sha256Text(leaseToken);
    const lease = {
      lease_id: crypto.randomUUID(), work_ref: issue.identifier, gate: lane.name, run_id: request.run_id,
      lease_token: leaseToken, token_hash: tokenHash, claim_idempotency_key: request.idempotency_key,
      claim_request_hash: requestHash, status: 'claiming', created_at: createdAt, expires_at: expiresAt,
      previous_state: issue.state.name, previous_state_id: issue.state.id, previous_lane: lane.name,
      previous_lane_id: lane.id, claim_revision: issue.updatedAt,
    };
    const inserted = await store.insertLease(lease);
    if (!inserted.inserted) return recoverClaimReplay(inserted.lease, requestHash);

    const acquired = await store.tryAcquireSlot(issue.identifier, lane.name, lease.lease_id, expiresAt);
    if (!acquired) {
      const active = await store.getSlot(issue.identifier, lane.name);
      await store.rejectLease(lease.lease_id, 'ALREADY_CLAIMED', { expires_at: active?.expires_at || null });
      throw err('ALREADY_CLAIMED', 'another unexpired lease owns this work item', { work_ref: issue.identifier, expires_at: active?.expires_at || null });
    }

    let activeIssue;
    try {
      activeIssue = await authoritative.transition({
        issue,
        expectedRevision: issue.updatedAt,
        expectedState: issue.state.name,
        expectedLane: lane.name,
        targetState: ACTIVE_STATE,
        targetLane: lane.name,
      });
    } catch (error) {
      const definitive = new Set([
        'WORK_STATE_CHANGED',
        'LINEAR_UPSTREAM_GRAPHQL',
        'LINEAR_CONFIGURATION_ERROR',
        'LINEAR_TRANSITION_FAILED',
      ]);
      if (definitive.has(error?.code)) {
        await store.rejectLease(lease.lease_id, error?.code || 'LINEAR_TRANSITION_FAILED', { upstream_code: error?.code || null });
        await store.releaseSlot(issue.identifier, lane.name, lease.lease_id);
        if (error?.code === 'WORK_STATE_CHANGED') throw error;
        throw err('LINEAR_TRANSITION_FAILED', 'required Linear transition failed', { upstream_code: error?.code || null });
      }
      throw err('CLAIM_INDETERMINATE', 'Linear claim transition outcome is ambiguous; retry only with the same idempotency_key', {
        upstream_code: error?.code || null,
        expires_at: expiresAt,
      });
    }

    const receipt = {
      ok: true,
      work_ref: issue.identifier,
      lease_token: leaseToken,
      lease_id: lease.lease_id,
      expires_at: expiresAt,
      previous_state: issue.state.name,
      current_state: activeIssue.state.name,
      lane: lane.name,
      authoritative_revision: activeIssue.updatedAt,
      idempotent_replay: false,
      snapshot: snapshot(activeIssue),
    };
    await store.activateLease(lease.lease_id, activeIssue.updatedAt, receipt);
    return receipt;
  }

  async function settle(input) {
    const request = normalizeSettleRequest(input);
    const requestHash = await sha256Text(canonicalJson(request));
    const tokenHash = await sha256Text(request.lease_token);
    let lease = await store.getLeaseByTokenHash(tokenHash);
    if (!lease) throw err('LEASE_INVALID', 'lease token is invalid');

    if (lease.settle_idempotency_key) {
      if (lease.settle_idempotency_key !== request.idempotency_key || lease.settle_request_hash !== requestHash) {
        throw err('LEASE_ALREADY_SETTLED', 'lease has already been consumed by a different settlement request');
      }
      if (lease.settle_receipt) return { ...lease.settle_receipt, idempotent_replay: true };
    }
    if (Date.parse(lease.expires_at) <= Date.parse(now())) throw err('LEASE_EXPIRED', 'lease has expired');
    if (!['active', 'settling'].includes(lease.status)) {
      if (lease.status === 'settled') throw err('LEASE_ALREADY_SETTLED', 'lease has already been consumed');
      throw err('LEASE_INVALID', `lease is ${lease.status}`);
    }
    const slot = await store.getSlot(lease.work_ref, lease.gate);
    if (!slot || slot.lease_id !== lease.lease_id || Date.parse(slot.expires_at) <= Date.parse(now())) {
      throw err('LEASE_EXPIRED', 'lease no longer owns the active slot');
    }

    let current = await authoritative.getIssue(lease.work_ref);
    const plan = lease.settle_plan || settlementPlan(lease, request, current);

    if (lease.status === 'settling' && issueMatches(current, plan)) {
      const receipt = {
        ok: true, work_ref: lease.work_ref, lease_id: lease.lease_id, disposition: request.disposition,
        previous_state: ACTIVE_STATE, current_state: current.state.name, previous_lane: lease.gate,
        current_lane: laneOf(current)?.name || null, settled_at: now(), idempotent_replay: true,
      };
      await store.completeSettlement(lease.lease_id, request.idempotency_key, requestHash, plan, receipt, receipt.settled_at);
      await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
      return receipt;
    }

    if (current.updatedAt !== lease.active_revision || !issueMatches(current, { state: ACTIVE_STATE, lane: lease.gate })) {
      await store.invalidateLease(lease.lease_id, { observed_revision: current.updatedAt, actual_state: current.state?.name || null, actual_lane: laneOf(current)?.name || null, invalidated_at: now() });
      await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
      throw err('WORK_STATE_CHANGED', 'authoritative work state changed after claim', { actual_state: current.state?.name || null, actual_lane: laneOf(current)?.name || null });
    }

    lease = await store.beginSettlement(lease.lease_id, request.idempotency_key, requestHash, plan);
    current = await authoritative.transition({
      issue: current,
      expectedRevision: current.updatedAt,
      expectedState: ACTIVE_STATE,
      expectedLane: lease.gate,
      targetState: plan.state,
      targetLane: plan.lane,
      description: plan.description,
    });

    const settledAt = now();
    const receipt = {
      ok: true,
      work_ref: lease.work_ref,
      lease_id: lease.lease_id,
      disposition: request.disposition,
      previous_state: ACTIVE_STATE,
      current_state: current.state.name,
      previous_lane: lease.gate,
      current_lane: laneOf(current)?.name || null,
      settled_at: settledAt,
      idempotent_replay: false,
    };
    await store.completeSettlement(lease.lease_id, request.idempotency_key, requestHash, plan, receipt, settledAt);
    await store.releaseSlot(lease.work_ref, lease.gate, lease.lease_id);
    return receipt;
  }

  return { claim, settle, reconcileExpired };
}

export function createLinearAuthority(apiBinding = api) {
  async function gql(query, variables) {
    const response = await apiBinding.call('linear', { method: 'POST', path: '', headers: { 'Content-Type': 'application/json' }, body: { query, variables } });
    if (!response || response.status < 200 || response.status >= 300) throw err('LINEAR_UPSTREAM_HTTP', `Linear returned HTTP ${response?.status ?? 'unknown'}`);
    let body = response.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (body?.errors?.length) throw err('LINEAR_UPSTREAM_GRAPHQL', String(body.errors[0]?.message || 'Linear GraphQL request failed'), { errors: body.errors.map(e => ({ message: e.message, code: e.extensions?.code || null })) });
    return body?.data || {};
  }

  async function getIssue(workRef) {
    const data = await gql(`query WorkLeaseIssue($id: String!) {
      issue(id: $id) {
        id identifier title description updatedAt archivedAt
        project { id name }
        state { id name type }
        labels { nodes { id name } }
        relations { nodes { id type relatedIssue { id identifier title } } }
        team {
          id name
          states { nodes { id name type } }
          labels { nodes { id name } }
        }
      }
    }`, { id: workRef });
    const issue = data.issue;
    if (!issue) throw err('WORK_NOT_FOUND', `Linear issue ${workRef} was not found`);
    return {
      ...issue,
      labels: issue.labels?.nodes || [],
      relations: issue.relations?.nodes || [],
      teamStates: issue.team?.states?.nodes || [],
      teamLabels: issue.team?.labels?.nodes || [],
    };
  }

  async function transition({ issue, expectedRevision, expectedState, expectedLane, targetState, targetLane, description = null }) {
    const fresh = await getIssue(issue.identifier);
    const freshLane = laneOf(fresh);
    if (fresh.updatedAt !== expectedRevision || fresh.state?.name !== expectedState || freshLane?.name !== expectedLane) {
      throw err('WORK_STATE_CHANGED', 'Linear work item changed before transition', { actual_state: fresh.state?.name || null, actual_lane: freshLane?.name || null, actual_revision: fresh.updatedAt });
    }
    const state = stateByName(fresh, targetState);
    const targetLabel = labelByName(fresh, targetLane);
    if (!state || !targetLabel) throw err('LINEAR_CONFIGURATION_ERROR', 'target state or lane is not configured in Linear', { target_state: targetState, target_lane: targetLane });
    const input = { stateId: state.id };
    if (freshLane.name !== targetLane) {
      input.addedLabelIds = [targetLabel.id];
      input.removedLabelIds = [freshLane.id];
    }
    if (description !== null) input.description = description;
    const data = await gql(`mutation WorkLeaseTransition($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`, { id: fresh.id, input });
    if (data.issueUpdate?.success !== true) throw err('LINEAR_TRANSITION_FAILED', 'Linear did not confirm issue transition');
    const updated = await getIssue(fresh.identifier);
    if (!issueMatches(updated, { state: targetState, lane: targetLane })) {
      throw err('LINEAR_TRANSITION_FAILED', 'Linear transition did not reach the requested state/lane', { actual_state: updated.state?.name || null, actual_lane: laneOf(updated)?.name || null });
    }
    return updated;
  }

  return { getIssue, transition };
}

export function createPostgresLeaseStore(dbBinding = db) {
  async function row(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows?.[0] || null;
  }
  return {
    async getClaimByIdempotency(key) { return row('SELECT * FROM work_leases WHERE claim_idempotency_key = $1', [key]); },
    async getLeaseById(id) { return row('SELECT * FROM work_leases WHERE lease_id = $1', [id]); },
    async getLeaseByTokenHash(hash) { return row('SELECT * FROM work_leases WHERE token_hash = $1', [hash]); },
    async getSlot(workRef, gate) { return row('SELECT * FROM work_lease_slots WHERE work_ref = $1 AND gate = $2', [workRef, gate]); },
    async insertLease(lease) {
      const inserted = await row(`INSERT INTO work_leases (
        lease_id, work_ref, gate, run_id, lease_token, token_hash, claim_idempotency_key, claim_request_hash,
        status, created_at, expires_at, previous_state, previous_state_id, previous_lane, previous_lane_id, claim_revision
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (claim_idempotency_key) DO NOTHING RETURNING *`, [
        lease.lease_id, lease.work_ref, lease.gate, lease.run_id, lease.lease_token, lease.token_hash,
        lease.claim_idempotency_key, lease.claim_request_hash, lease.status, lease.created_at, lease.expires_at,
        lease.previous_state, lease.previous_state_id, lease.previous_lane, lease.previous_lane_id, lease.claim_revision,
      ]);
      if (inserted) return { inserted: true, lease: inserted };
      return { inserted: false, lease: await this.getClaimByIdempotency(lease.claim_idempotency_key) };
    },
    async tryAcquireSlot(workRef, gate, leaseId, expiresAt) {
      return Boolean(await row('INSERT INTO work_lease_slots (work_ref, gate, lease_id, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (work_ref, gate) DO NOTHING RETURNING lease_id', [workRef, gate, leaseId, expiresAt]));
    },
    async activateLease(id, activeRevision, receipt) {
      return row("UPDATE work_leases SET status = 'active', active_revision = $2, claim_receipt = $3::jsonb, updated_at = now() WHERE lease_id = $1 RETURNING *", [id, activeRevision, JSON.stringify(receipt)]);
    },
    async rejectLease(id, code, details) {
      return row("UPDATE work_leases SET status = 'rejected', reconciliation = $2::jsonb, updated_at = now() WHERE lease_id = $1 RETURNING *", [id, JSON.stringify({ rejection_code: code, rejection_details: details })]);
    },
    async markExpired(id, reconciliation) {
      return row("UPDATE work_leases SET status = 'expired', reconciliation = $2::jsonb, updated_at = now() WHERE lease_id = $1 AND status <> 'settled' RETURNING *", [id, JSON.stringify(reconciliation)]);
    },
    async invalidateLease(id, reconciliation) {
      return row("UPDATE work_leases SET status = 'invalidated', reconciliation = $2::jsonb, updated_at = now() WHERE lease_id = $1 AND status <> 'settled' RETURNING *", [id, JSON.stringify(reconciliation)]);
    },
    async releaseSlot(workRef, gate, leaseId) {
      const result = await dbBinding.query('DELETE FROM work_lease_slots WHERE work_ref = $1 AND gate = $2 AND lease_id = $3', [workRef, gate, leaseId]);
      return result.rowCount || 0;
    },
    async beginSettlement(id, idem, hash, plan) {
      const updated = await row("UPDATE work_leases SET status = 'settling', settle_idempotency_key = $2, settle_request_hash = $3, settle_plan = $4::jsonb, updated_at = now() WHERE lease_id = $1 AND status = 'active' AND settle_idempotency_key IS NULL RETURNING *", [id, idem, hash, JSON.stringify(plan)]);
      if (updated) return updated;
      const existing = await this.getLeaseById(id);
      if (existing?.settle_idempotency_key === idem && existing?.settle_request_hash === hash) return existing;
      throw err('LEASE_ALREADY_SETTLED', 'lease settlement was already started by another request');
    },
    async completeSettlement(id, idem, hash, plan, receipt, settledAt) {
      return row("UPDATE work_leases SET status = 'settled', settle_idempotency_key = $2, settle_request_hash = $3, settle_plan = $4::jsonb, settle_receipt = $5::jsonb, settled_at = $6, updated_at = now() WHERE lease_id = $1 RETURNING *", [id, idem, hash, JSON.stringify(plan), JSON.stringify(receipt), settledAt]);
    },
  };
}

export function createPostgresWorkLeaseService(options = {}) {
  return createWorkLeaseService({ store: createPostgresLeaseStore(options.db || db), authoritative: createLinearAuthority(options.api || api), now: options.now, tokenFactory: options.tokenFactory });
}

export function statusForWorkLeaseError(error) {
  const code = String(error?.code || 'WORK_LEASE_ERROR');
  if (code === 'REQUEST_INVALID') return 400;
  if (code === 'WORK_NOT_FOUND') return 404;
  if (['ALREADY_CLAIMED','STATE_MISMATCH','LANE_MISMATCH','NON_EXECUTABLE_WORK','LEASE_EXPIRED','LEASE_ALREADY_SETTLED','WORK_STATE_CHANGED','IDEMPOTENCY_CONFLICT','CLAIM_INDETERMINATE','INVALID_SUCCESSOR'].includes(code)) return 409;
  if (code.startsWith('LINEAR_')) return 502;
  return 500;
}

export const workLeaseConfig = Object.freeze({
  project: PROJECT,
  active_state: ACTIVE_STATE,
  default_lease_seconds: DEFAULT_LEASE_SECONDS,
  min_lease_seconds: MIN_LEASE_SECONDS,
  max_lease_seconds: MAX_LEASE_SECONDS,
  dispositions: [...DISPOSITIONS],
  execution_lanes: [...EXECUTION_LANES],
  successor: SUCCESSOR,
});

export const workLeaseInternals = Object.freeze({ normalizeClaimRequest, normalizeSettleRequest, settlementPlan, isExecutable, laneOf, snapshot, publicLease });