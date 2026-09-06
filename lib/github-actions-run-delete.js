const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;

function failure(error, message, details = {}) {
  return { ok:false, error, message, may_have_mutated:false, ...details };
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('request must be an object'), { code:'INVALID_REQUEST' });
  const allowed = new Set(['repo','workflow_run_id','expected_head_sha']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw Object.assign(new Error('request contains unknown fields'), { code:'INVALID_REQUEST', details:{ unknown } });
  const repo = String(input.repo || '').trim();
  const runId = Number(input.workflow_run_id);
  const expectedHeadSha = String(input.expected_head_sha || '').trim().toLowerCase();
  if (!REPO.test(repo)) throw Object.assign(new Error('repo must be owner/repo'), { code:'INVALID_REPOSITORY' });
  if (!Number.isSafeInteger(runId) || runId <= 0) throw Object.assign(new Error('workflow_run_id must be a positive integer'), { code:'INVALID_REQUEST' });
  if (!SHA40.test(expectedHeadSha)) throw Object.assign(new Error('expected_head_sha must be a full 40-character Git commit SHA'), { code:'INVALID_SHA' });
  return { repo, workflow_run_id:runId, expected_head_sha:expectedHeadSha };
}

export function normalizeGithubActionsRunDeleteRequest(input) {
  return normalize(input);
}

function runPath(repo, runId) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}`;
}

async function readRun(apiClient, normalized, phase) {
  const path = runPath(normalized.repo, normalized.workflow_run_id);
  let response;
  try {
    response = await apiClient.call('github', { path, method:'GET' });
  } catch (error) {
    return failure('GITHUB_UPSTREAM_ERROR', String(error?.message || error), { phase, github_path:path });
  }
  const status = Number(response?.status || 0);
  if (status === 404) return { ok:true, absent:true, path };
  if (status === 401 || status === 403) return failure('GITHUB_PERMISSION_DENIED', String(response?.body?.message || `GitHub returned HTTP ${status}`), { upstream_status:status, phase, github_path:path });
  if (status < 200 || status >= 300) return failure('GITHUB_UPSTREAM_ERROR', String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`), { ...(status ? { upstream_status:status } : {}), phase, github_path:path });
  const runId = Number(response?.body?.id || 0);
  const headSha = typeof response?.body?.head_sha === 'string' ? response.body.head_sha.toLowerCase() : '';
  if (runId !== normalized.workflow_run_id || !SHA40.test(headSha)) {
    return failure('GITHUB_INVALID_RESPONSE', 'GitHub returned a workflow run without the requested exact identity.', { phase, github_path:path, observed_workflow_run_id:runId || null, observed_head_sha:headSha || null });
  }
  return { ok:true, absent:false, path, run:{ id:runId, head_sha:headSha } };
}

function absentSuccess(normalized, outcome, details = {}) {
  return {
    ok:true,
    outcome,
    repo:normalized.repo,
    workflow_run_id:normalized.workflow_run_id,
    expected_head_sha:normalized.expected_head_sha,
    run_absent:true,
    ...details,
  };
}

export async function deleteGithubActionsRun(input, options = {}) {
  let normalized;
  try { normalized = normalize(input); }
  catch (error) { return failure(error?.code || 'INVALID_REQUEST', String(error?.message || error), error?.details || {}); }
  const apiClient = options.apiClient;
  if (!apiClient || typeof apiClient.call !== 'function') return failure('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub API transport is required.');

  const before = await readRun(apiClient, normalized, 'preflight');
  if (!before.ok) return before;
  if (before.absent) return absentSuccess(normalized, 'already_absent', { precondition_verified:false });

  if (before.run.head_sha !== normalized.expected_head_sha) {
    return failure('HEAD_MISMATCH', 'expected_head_sha does not match the authoritative workflow run head SHA.', {
      repo:normalized.repo,
      workflow_run_id:normalized.workflow_run_id,
      expected_head_sha:normalized.expected_head_sha,
      actual_head_sha:before.run.head_sha,
      phase:'preflight',
    });
  }

  const path = before.path;
  let deleteResponse = null;
  let dispatchUncertain = false;
  try {
    deleteResponse = await apiClient.call('github', { path, method:'DELETE' });
  } catch {
    dispatchUncertain = true;
  }

  const deleteStatus = Number(deleteResponse?.status || 0);
  if (!dispatchUncertain && ![204, 404].includes(deleteStatus)) {
    if (deleteStatus === 401 || deleteStatus === 403) {
      return failure('GITHUB_PERMISSION_DENIED', String(deleteResponse?.body?.message || `GitHub returned HTTP ${deleteStatus}`), {
        upstream_status:deleteStatus, phase:'delete', github_path:path, may_have_mutated:true,
      });
    }
    return failure('GITHUB_ACTIONS_RUN_DELETE_INDETERMINATE', String(deleteResponse?.body?.message || `GitHub returned HTTP ${deleteStatus || 'unknown'}`), {
      ...(deleteStatus ? { upstream_status:deleteStatus } : {}), phase:'delete', github_path:path, may_have_mutated:true,
    });
  }

  const after = await readRun(apiClient, normalized, dispatchUncertain ? 'reconcile_after_uncertainty' : 'verify_absent');
  if (!after.ok) {
    return failure('GITHUB_ACTIONS_RUN_DELETE_INDETERMINATE', 'Workflow run deletion was dispatched but authoritative absence could not be established.', {
      phase:after.phase || (dispatchUncertain ? 'reconcile_after_uncertainty' : 'verify_absent'),
      github_path:path,
      may_have_mutated:true,
      reconciliation_error:after,
    });
  }
  if (!after.absent) {
    return failure('GITHUB_ACTIONS_RUN_DELETE_NOT_APPLIED', 'Authoritative readback still finds the exact workflow run after deletion dispatch.', {
      repo:normalized.repo,
      workflow_run_id:normalized.workflow_run_id,
      expected_head_sha:normalized.expected_head_sha,
      actual_head_sha:after.run.head_sha,
      phase:dispatchUncertain ? 'reconcile_after_uncertainty' : 'verify_absent',
      github_path:path,
      may_have_mutated:false,
    });
  }

  return absentSuccess(normalized, deleteStatus === 404 ? 'already_absent' : 'deleted', {
    observed_head_sha:before.run.head_sha,
    precondition_verified:true,
    ...(dispatchUncertain ? { reconciled_after_uncertainty:true } : {}),
  });
}