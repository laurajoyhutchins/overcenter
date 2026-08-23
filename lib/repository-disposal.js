import { api, db } from 'hatchable';
import { canonicalRepository, createPostgresRepositoryLifecycleService, statusForRepositoryDispositionError } from './repository-disposition.js';

const TERMINAL_LINEAR_STATES = new Set(['completed', 'canceled', 'duplicate']);
const LIVE_LEASE_STATES = ['claiming', 'active', 'settling'];

function disposalError(code, message, details = null, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function parseRepository(description) {
  const text = String(description || '');
  const direct = text.match(/^\s*Repository\s*:\s*`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?[.,;:]?\s*$/mi);
  if (direct) return direct[1];
  const heading = text.match(/^\s*##\s+Repository\s*$[\s\r\n]*`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?/mi);
  return heading ? heading[1] : null;
}

function executionLanes(issue) {
  return (issue?.labels?.nodes || issue?.labels || [])
    .map(label => typeof label === 'string' ? label : label?.name)
    .filter(name => /^lane:/.test(String(name || '')));
}

async function linearGraphQL(apiBinding, query, variables, { mayHaveMutated = false } = {}) {
  let response;
  try {
    response = await apiBinding.call('linear', {
      method: 'POST',
      path: '',
      headers: { 'Content-Type': 'application/json' },
      body: { query, variables },
    });
  } catch (error) {
    throw disposalError(
      mayHaveMutated ? 'REPOSITORY_DISPOSAL_LINEAR_INDETERMINATE' : 'REPOSITORY_DISPOSAL_LINEAR_UPSTREAM',
      String(error?.message || 'Linear transport failed'),
      { may_have_mutated: mayHaveMutated, upstream_code: error?.code || null },
      mayHaveMutated ? 409 : 502,
    );
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw disposalError(
      mayHaveMutated ? 'REPOSITORY_DISPOSAL_LINEAR_INDETERMINATE' : 'REPOSITORY_DISPOSAL_LINEAR_UPSTREAM',
      `Linear API returned HTTP ${response?.status ?? 'unknown'}`,
      { may_have_mutated: mayHaveMutated, upstream_status: response?.status || null },
      mayHaveMutated ? 409 : 502,
    );
  }
  let body = response.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { throw disposalError('REPOSITORY_DISPOSAL_LINEAR_INVALID', 'Linear returned a non-JSON response', null, 502); }
  }
  if (Array.isArray(body?.errors) && body.errors.length) {
    throw disposalError(
      mayHaveMutated ? 'REPOSITORY_DISPOSAL_LINEAR_INDETERMINATE' : 'REPOSITORY_DISPOSAL_LINEAR_GRAPHQL',
      String(body.errors[0]?.message || 'Linear GraphQL request failed'),
      { may_have_mutated: mayHaveMutated, errors: body.errors.map(error => ({ message: String(error?.message || ''), code: error?.extensions?.code || null })) },
      mayHaveMutated ? 409 : 502,
    );
  }
  return body?.data || null;
}

export function createLinearRepositoryRetirementSurface({ apiBinding = api, maxPages = 30 } = {}) {
  async function listRepositoryWork(repositoryInput) {
    const repository = canonicalRepository(repositoryInput);
    const query = `query RepositoryRetirementWork($after:String){
      issues(first:100,after:$after,includeArchived:true){
        nodes{
          id identifier title description archivedAt
          state{id name type}
          labels{nodes{name}}
          team{id name states(first:50){nodes{id name type}}}
          project{name}
        }
        pageInfo{hasNextPage endCursor}
      }
    }`;
    const matches = [];
    let after = null;
    let pages = 0;
    do {
      const data = await linearGraphQL(apiBinding, query, { after });
      const connection = data?.issues;
      if (!connection) throw disposalError('REPOSITORY_DISPOSAL_LINEAR_INVALID', 'Linear issue connection was missing', null, 502);
      for (const issue of connection.nodes || []) {
        const coordinate = parseRepository(issue.description);
        const lanes = executionLanes(issue);
        if (!coordinate || coordinate.toLowerCase() !== repository.toLowerCase() || lanes.length !== 1) continue;
        const canceledState = (issue.team?.states?.nodes || []).find(state => String(state.type || '').toLowerCase() === 'canceled') || null;
        matches.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          repository: coordinate,
          archivedAt: issue.archivedAt || null,
          state: { id: issue.state?.id || null, name: issue.state?.name || null, type: String(issue.state?.type || '').toLowerCase() || null },
          lane: lanes[0],
          project: issue.project?.name || null,
          team: issue.team?.name || null,
          canceled_state_id: canceledState?.id || null,
        });
      }
      pages += 1;
      after = connection.pageInfo?.hasNextPage ? connection.pageInfo?.endCursor || null : null;
      if (after && pages >= maxPages) throw disposalError('REPOSITORY_DISPOSAL_LINEAR_SCAN_LIMIT', 'Linear repository retirement scan exceeded its deterministic page bound', { repository, max_pages: maxPages }, 409);
    } while (after);
    return matches;
  }

  async function inspect(issueId) {
    const data = await linearGraphQL(apiBinding, `query RepositoryRetirementIssue($id:String!){issue(id:$id){id identifier title archivedAt state{id name type} team{id states(first:50){nodes{id name type}}}}}`, { id: String(issueId) });
    const issue = data?.issue;
    if (!issue) throw disposalError('REPOSITORY_DISPOSAL_LINEAR_NOT_FOUND', 'Linear work projection was not found', { issue: issueId }, 404);
    const canceledState = (issue.team?.states?.nodes || []).find(state => String(state.type || '').toLowerCase() === 'canceled') || null;
    return { id: issue.id, identifier: issue.identifier, title: issue.title, archivedAt: issue.archivedAt || null, state: { id: issue.state?.id || null, name: issue.state?.name || null, type: String(issue.state?.type || '').toLowerCase() || null }, canceled_state_id: canceledState?.id || null };
  }

  async function retire(input) {
    let current = input?.id ? await inspect(input.id) : input;
    if (!current?.id) throw disposalError('REPOSITORY_DISPOSAL_LINEAR_NOT_FOUND', 'Linear work projection has no id', null, 404);
    if (current.archivedAt) return { identifier: current.identifier, archived: true, changed: false, canceled: TERMINAL_LINEAR_STATES.has(current.state?.type) };

    if (!TERMINAL_LINEAR_STATES.has(String(current.state?.type || '').toLowerCase())) {
      const canceledStateId = current.canceled_state_id || input?.canceled_state_id;
      if (!canceledStateId) throw disposalError('REPOSITORY_DISPOSAL_NO_CANCELED_STATE', 'Cannot retire non-terminal Linear projection without a canceled workflow state', { identifier: current.identifier }, 409);
      try {
        const update = await linearGraphQL(apiBinding, `mutation RepositoryRetirementCancel($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success issue{id identifier archivedAt state{id name type}}}}`, { id: current.id, input: { stateId: canceledStateId } }, { mayHaveMutated: true });
        if (update?.issueUpdate?.success !== true) throw disposalError('REPOSITORY_DISPOSAL_LINEAR_NOT_CONFIRMED', 'Linear did not confirm cancellation', { identifier: current.identifier }, 409);
        current = { ...current, state: { id: update.issueUpdate.issue?.state?.id || canceledStateId, name: update.issueUpdate.issue?.state?.name || 'Canceled', type: String(update.issueUpdate.issue?.state?.type || 'canceled').toLowerCase() } };
      } catch (error) {
        if (error?.code !== 'REPOSITORY_DISPOSAL_LINEAR_INDETERMINATE') throw error;
        const observed = await inspect(current.id);
        if (String(observed.state?.type || '').toLowerCase() !== 'canceled') throw error;
        current = { ...current, ...observed };
      }
    }

    try {
      const archived = await linearGraphQL(apiBinding, `mutation RepositoryRetirementArchive($id:String!){issueArchive(id:$id){success}}`, { id: current.id }, { mayHaveMutated: true });
      if (archived?.issueArchive?.success !== true) throw disposalError('REPOSITORY_DISPOSAL_LINEAR_NOT_CONFIRMED', 'Linear did not confirm archival', { identifier: current.identifier }, 409);
      return { identifier: current.identifier, archived: true, changed: true, canceled: true };
    } catch (error) {
      if (error?.code !== 'REPOSITORY_DISPOSAL_LINEAR_INDETERMINATE') throw error;
      const observed = await inspect(current.id);
      if (!observed.archivedAt) throw error;
      return { identifier: observed.identifier, archived: true, changed: true, canceled: true, reconciled_after_indeterminate: true };
    }
  }

  return { listRepositoryWork, retire, inspect };
}

export function createPostgresRepositoryLeaseRetirementStore(dbBinding = db) {
  return {
    async invalidateWorkRefs(workRefs, metadata = {}) {
      const unique = [...new Set((workRefs || []).map(value => String(value || '').trim()).filter(Boolean))];
      const invalidated = [];
      for (const workRef of unique) {
        const reconciliation = JSON.stringify({
          reason: metadata.reason || 'repository_disposed',
          repository: metadata.repository || null,
          disposition: metadata.disposition || null,
          invalidated_at: metadata.invalidated_at || new Date().toISOString(),
          phase: 'repository_disposal',
        });
        const result = await dbBinding.query(`UPDATE work_leases SET status='invalidated', reconciliation=$2::jsonb, updated_at=now() WHERE work_ref=$1 AND status IN ('claiming','active','settling') RETURNING lease_id::text AS lease_id, work_ref, gate, status`, [workRef, reconciliation]);
        await dbBinding.query('DELETE FROM work_lease_slots WHERE work_ref=$1', [workRef]);
        invalidated.push(...(result.rows || []));
      }
      return invalidated;
    },
    async activeForWorkRefs(workRefs) {
      const unique = [...new Set((workRefs || []).map(value => String(value || '').trim()).filter(Boolean))];
      const active = [];
      for (const workRef of unique) {
        const leases = await dbBinding.query(`SELECT lease_id::text AS lease_id, work_ref, gate, status FROM work_leases WHERE work_ref=$1 AND status IN ('claiming','active','settling')`, [workRef]);
        const slots = await dbBinding.query('SELECT lease_id::text AS lease_id, work_ref, gate, expires_at FROM work_lease_slots WHERE work_ref=$1', [workRef]);
        active.push(...(leases.rows || []).map(row => ({ ...row, kind: 'lease' })), ...(slots.rows || []).map(row => ({ ...row, kind: 'slot' })));
      }
      return active;
    },
  };
}

export function createRepositoryDisposalService({ lifecycle, workSurface, leases, now = () => new Date().toISOString() } = {}) {
  if (!lifecycle || !workSurface || !leases) throw new TypeError('lifecycle, workSurface, and leases are required');

  async function verify(repositoryInput) {
    const repository = canonicalRepository(repositoryInput);
    const lifecyclePacket = await lifecycle.verify(repository);
    const historicalWork = await workSurface.listRepositoryWork(repository);
    const liveWork = historicalWork.filter(item => !item.archivedAt);
    const activeLeases = await leases.activeForWorkRefs(historicalWork.map(item => item.identifier));
    const clean = lifecyclePacket.ordinary_work_enabled === false && liveWork.length === 0 && activeLeases.length === 0;
    return {
      ...lifecyclePacket,
      ok: clean,
      successor: lifecyclePacket.successor || lifecyclePacket.successor_repository || null,
      ordinary_work_enabled: lifecyclePacket.ordinary_work_enabled === true,
      linear_projection_enabled: lifecyclePacket.linear_projection_enabled === true,
      scheduled_worker_target: lifecyclePacket.scheduled_worker_target === true,
      fast_forward_eligible: lifecyclePacket.fast_forward_eligible === true,
      historical_linear_refs: historicalWork.map(item => item.identifier),
      active_linear_refs: liveWork.map(item => item.identifier),
      active_lease_evidence: activeLeases,
      checks: {
        ...lifecyclePacket.checks,
        executable_portfolio_work: liveWork.length ? liveWork.map(item => item.identifier) : 'none',
        linear_projection: lifecyclePacket.linear_projection_enabled ? 'enabled' : (liveWork.length ? 'disabled_with_stale_projection' : 'disabled'),
        active_leases: activeLeases.length ? activeLeases.map(item => ({ work_ref: item.work_ref, gate: item.gate, kind: item.kind })) : 'none',
      },
    };
  }

  async function dispose(input = {}) {
    const repository = canonicalRepository(input.repository);
    if (Object.prototype.hasOwnProperty.call(input, 'compatibility_bound') || Object.prototype.hasOwnProperty.call(input, 'compatibility_reference')) {
      throw disposalError('LEGACY_CONTROL_PLANE_RETIRED', 'repository compatibility execution exceptions are retired; use ordinary disposal', { repository, replacement: 'busbar' }, 410);
    }
    // First mutation is lifecycle state. All ordinary admission paths fail closed from this point onward.
    const lifecycleState = await lifecycle.dispose({
      repository,
      disposition: input.disposition || 'ARCHIVED',
      successor_repository: input.successor_repository,
      reason: input.reason || 'repository_disposed',
    });

    const observedWork = await workSurface.listRepositoryWork(repository);
    const liveWork = observedWork.filter(item => !item.archivedAt);
    const workRefs = liveWork.map(item => item.identifier);
    const invalidatedLeases = await leases.invalidateWorkRefs(workRefs, {
      reason: 'repository_disposed',
      repository: lifecycleState.repository,
      disposition: lifecycleState.disposition,
      invalidated_at: now(),
    });
    const retiredLinear = [];
    for (const item of liveWork) {
      const retired = await workSurface.retire(item);
      if (retired.changed !== false) retiredLinear.push(retired.identifier || item.identifier);
    }
    const verification = await verify(repository);
    if (!verification.ok) {
      throw disposalError('REPOSITORY_DISPOSAL_INCOMPLETE', 'repository retirement verification still found executable state', {
        repository,
        active_linear_refs: verification.active_linear_refs,
        active_lease_evidence: verification.active_lease_evidence,
      }, 409);
    }
    return {
      ok: true,
      action: 'portfolio.dispose_repository',
      repository: lifecycleState.repository,
      disposition: lifecycleState.disposition,
      successor_repository: lifecycleState.successor_repository,
      changed: lifecycleState.changed === true || retiredLinear.length > 0 || invalidatedLeases.length > 0,
      retired_linear_refs: retiredLinear,
      invalidated_leases: invalidatedLeases,
      verification,
    };
  }

  return { dispose, verify };
}

export function createPostgresRepositoryDisposalService(options = {}) {
  const dbBinding = options.db || db;
  return createRepositoryDisposalService({
    lifecycle: options.lifecycle || createPostgresRepositoryLifecycleService({ db: dbBinding, api: options.api || api, now: options.now }),
    workSurface: options.workSurface || createLinearRepositoryRetirementSurface({ apiBinding: options.api || api }),
    leases: options.leases || createPostgresRepositoryLeaseRetirementStore(dbBinding),
    now: options.now,
  });
}

export async function disposeRepository(input, options = {}) {
  return createPostgresRepositoryDisposalService(options).dispose(input);
}

export async function verifyRepositoryRetirement(repository, options = {}) {
  return createPostgresRepositoryDisposalService(options).verify(repository);
}

export function statusForRepositoryDisposalError(error) {
  if (Number.isInteger(error?.status)) return error.status;
  return statusForRepositoryDispositionError(error);
}