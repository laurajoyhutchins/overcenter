import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OPERATIONS = new Set(['inspect', 'delete_artifacts', 'set_retention']);

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

function object(value, field = 'request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REQUEST', `${field} must be an object`, { field });
  }
  return value;
}

function exactFields(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', 'request contains unknown fields', { unknown });
}

function normalizeRepo(value) {
  const repo = String(value || '').trim();
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be in owner/repo form');
  return repo;
}

function normalizeArtifactIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    fail('INVALID_REQUEST', 'artifact_ids must be a non-empty array with at most 1000 entries');
  }
  const ids = value.map((id) => Number(id));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    fail('INVALID_REQUEST', 'artifact_ids must contain positive integer artifact ids');
  }
  if (new Set(ids).size !== ids.length) fail('INVALID_REQUEST', 'artifact_ids must not contain duplicates');
  return ids;
}

function normalizeDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 400) {
    fail('INVALID_REQUEST', 'days must be an integer from 1 through 400');
  }
  return days;
}

export function normalizeGithubActionsStorageRequest(input) {
  const body = object(input);
  const repo = normalizeRepo(body.repo);
  const operation = String(body.operation || '').trim();
  if (!OPERATIONS.has(operation)) fail('INVALID_REQUEST', 'operation must be inspect, delete_artifacts, or set_retention');

  if (operation === 'inspect') {
    exactFields(body, new Set(['repo', 'operation']));
    return { repo, operation };
  }
  if (operation === 'delete_artifacts') {
    exactFields(body, new Set(['repo', 'operation', 'artifact_ids']));
    return { repo, operation, artifact_ids: normalizeArtifactIds(body.artifact_ids) };
  }
  exactFields(body, new Set(['repo', 'operation', 'days']));
  return { repo, operation, days: normalizeDays(body.days) };
}

function repoPath(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function upstreamFailure(response, phase, mayHaveMutated = false) {
  const status = Number(response?.status || 0);
  const message = response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`;
  if (status === 401 || status === 403) {
    return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message: String(message), upstream_status: status, phase, may_have_mutated: mayHaveMutated };
  }
  if (status === 404) {
    return { ok: false, error: 'GITHUB_NOT_FOUND', message: String(message), upstream_status: status, phase, may_have_mutated: mayHaveMutated };
  }
  return { ok: false, error: mayHaveMutated ? 'GITHUB_ACTIONS_STORAGE_INDETERMINATE' : 'GITHUB_UPSTREAM_ERROR', message: String(message), ...(status ? { upstream_status: status } : {}), phase, may_have_mutated: mayHaveMutated };
}

function artifactView(artifact) {
  return {
    id: Number(artifact?.id || 0),
    name: String(artifact?.name || ''),
    size_in_bytes: Number(artifact?.size_in_bytes || 0),
    expired: Boolean(artifact?.expired),
    created_at: artifact?.created_at || null,
    updated_at: artifact?.updated_at || null,
    expires_at: artifact?.expires_at || null,
    workflow_run_id: artifact?.workflow_run?.id ? Number(artifact.workflow_run.id) : null,
  };
}

export async function inspectGithubActionsStorage(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubActionsStorageRequest(input); }
  catch (error) { return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}) }; }
  if (normalized.operation !== 'inspect') return { ok: false, error: 'INVALID_OPERATION', message: 'inspectGithubActionsStorage requires operation=inspect' };
  const apiClient = options.apiClient;
  if (!apiClient) return { ok: false, error: 'GITHUB_TRANSPORT_UNAVAILABLE', message: 'A GitHub API transport is required.' };

  const artifacts = [];
  let totalCount = null;
  for (let page = 1; page <= 100; page += 1) {
    let response;
    try {
      response = await apiClient.call('github', {
        path: `${repoPath(normalized.repo)}/actions/artifacts`,
        method: 'GET',
        query: { per_page: 100, page },
      });
    } catch (error) {
      return { ok: false, error: 'GITHUB_UPSTREAM_ERROR', message: String(error?.message || error), phase: 'inspect', may_have_mutated: false };
    }
    if (!response || response.status < 200 || response.status >= 300) return upstreamFailure(response, 'inspect', false);
    const pageArtifacts = Array.isArray(response.body?.artifacts) ? response.body.artifacts : [];
    if (totalCount === null) totalCount = Number(response.body?.total_count ?? pageArtifacts.length);
    artifacts.push(...pageArtifacts.map(artifactView));
    if (pageArtifacts.length === 0 || artifacts.length >= totalCount) break;
    if (page === 100) return { ok: false, error: 'GITHUB_ACTIONS_STORAGE_TOO_LARGE', message: 'Artifact inventory exceeded the 10,000-item safety cap.', phase: 'inspect', may_have_mutated: false };
  }

  const live = artifacts.filter((artifact) => !artifact.expired);
  const sum = (items) => items.reduce((total, item) => total + Number(item.size_in_bytes || 0), 0);
  return {
    ok: true,
    outcome: 'inspected',
    repo: normalized.repo,
    artifact_count: artifacts.length,
    live_artifact_count: live.length,
    expired_artifact_count: artifacts.length - live.length,
    total_size_in_bytes: sum(artifacts),
    live_size_in_bytes: sum(live),
    artifacts,
  };
}

export async function deleteGithubActionsArtifacts(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubActionsStorageRequest(input); }
  catch (error) { return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}) }; }
  if (normalized.operation !== 'delete_artifacts') return { ok: false, error: 'INVALID_OPERATION', message: 'deleteGithubActionsArtifacts requires operation=delete_artifacts' };
  const apiClient = options.apiClient;
  if (!apiClient) return { ok: false, error: 'GITHUB_TRANSPORT_UNAVAILABLE', message: 'A GitHub API transport is required.' };

  const results = [];
  let reclaimed = 0;
  for (const artifactId of normalized.artifact_ids) {
    const path = `${repoPath(normalized.repo)}/actions/artifacts/${artifactId}`;
    let observed;
    try { observed = await apiClient.call('github', { path, method: 'GET' }); }
    catch (error) {
      return { ok: false, error: 'GITHUB_ACTIONS_STORAGE_PARTIAL_FAILURE', message: String(error?.message || error), phase: 'preflight', may_have_mutated: results.some((item) => item.outcome === 'deleted'), results };
    }
    if (Number(observed?.status) === 404) {
      results.push({ artifact_id: artifactId, outcome: 'already_absent' });
      continue;
    }
    if (!observed || observed.status < 200 || observed.status >= 300) {
      return { ...upstreamFailure(observed, 'preflight', results.some((item) => item.outcome === 'deleted')), results };
    }

    const view = artifactView(observed.body || {});
    let deleted;
    try { deleted = await apiClient.call('github', { path, method: 'DELETE' }); }
    catch (error) {
      return { ok: false, error: 'GITHUB_ACTIONS_STORAGE_INDETERMINATE', message: String(error?.message || error), phase: 'delete', may_have_mutated: true, artifact_id: artifactId, results };
    }
    if (Number(deleted?.status) === 404) {
      results.push({ artifact_id: artifactId, outcome: 'already_absent' });
      continue;
    }
    if (Number(deleted?.status) !== 204) {
      return { ...upstreamFailure(deleted, 'delete', true), artifact_id: artifactId, results };
    }
    reclaimed += view.size_in_bytes;
    results.push({ artifact_id: artifactId, name: view.name, size_in_bytes: view.size_in_bytes, outcome: 'deleted' });
  }

  return {
    ok: true,
    outcome: 'completed',
    repo: normalized.repo,
    requested_count: normalized.artifact_ids.length,
    deleted_count: results.filter((item) => item.outcome === 'deleted').length,
    already_absent_count: results.filter((item) => item.outcome === 'already_absent').length,
    reclaimed_size_in_bytes: reclaimed,
    results,
  };
}

export async function setGithubActionsRetention(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubActionsStorageRequest(input); }
  catch (error) { return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}) }; }
  if (normalized.operation !== 'set_retention') return { ok: false, error: 'INVALID_OPERATION', message: 'setGithubActionsRetention requires operation=set_retention' };
  const apiClient = options.apiClient;
  if (!apiClient) return { ok: false, error: 'GITHUB_TRANSPORT_UNAVAILABLE', message: 'A GitHub API transport is required.' };

  const path = `${repoPath(normalized.repo)}/actions/permissions/artifact-and-log-retention`;
  let before;
  try { before = await apiClient.call('github', { path, method: 'GET' }); }
  catch (error) { return { ok: false, error: 'GITHUB_UPSTREAM_ERROR', message: String(error?.message || error), phase: 'retention_preflight', may_have_mutated: false }; }
  if (!before || before.status < 200 || before.status >= 300) return upstreamFailure(before, 'retention_preflight', false);
  const previousDays = Number(before.body?.days || 0);
  const maximumAllowedDays = Number(before.body?.maximum_allowed_days || 0) || null;
  if (maximumAllowedDays && normalized.days > maximumAllowedDays) {
    return { ok: false, error: 'RETENTION_EXCEEDS_MAXIMUM', message: `Requested retention exceeds GitHub's maximum of ${maximumAllowedDays} days.`, requested_days: normalized.days, maximum_allowed_days: maximumAllowedDays };
  }
  if (previousDays === normalized.days) {
    return { ok: true, outcome: 'unchanged', repo: normalized.repo, previous_days: previousDays, current_days: previousDays, maximum_allowed_days: maximumAllowedDays };
  }

  let write;
  try { write = await apiClient.call('github', { path, method: 'PUT', body: { days: normalized.days } }); }
  catch (error) { return { ok: false, error: 'GITHUB_ACTIONS_STORAGE_INDETERMINATE', message: String(error?.message || error), phase: 'retention_write', may_have_mutated: true }; }
  if (Number(write?.status) !== 204) return upstreamFailure(write, 'retention_write', true);

  let after;
  try { after = await apiClient.call('github', { path, method: 'GET' }); }
  catch (error) { return { ok: false, error: 'RETENTION_VERIFY_INDETERMINATE', message: String(error?.message || error), phase: 'retention_verify', may_have_mutated: true }; }
  if (!after || after.status < 200 || after.status >= 300) return upstreamFailure(after, 'retention_verify', true);
  const currentDays = Number(after.body?.days || 0);
  if (currentDays !== normalized.days) {
    return { ok: false, error: 'RETENTION_VERIFY_FAILED', message: 'GitHub did not report the requested retention after the update.', requested_days: normalized.days, previous_days: previousDays, current_days: currentDays, may_have_mutated: true };
  }
  return { ok: true, outcome: 'updated', repo: normalized.repo, previous_days: previousDays, current_days: currentDays, maximum_allowed_days: Number(after.body?.maximum_allowed_days || maximumAllowedDays || 0) || null };
}

function authFailure(error) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  const setupRequired = /config\/get 412|declared as required but not set/i.test(message);
  if (setupRequired) return { ok: false, error: 'GITHUB_APP_SETUP_REQUIRED', message: 'Configure the GitHub App ID and private key in Hatchable Setup before using this command.' };
  if (Number(error?.status) === 401 || Number(error?.status) === 403 || Number(error?.status) === 422) {
    return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message, ...(error?.status ? { upstream_status: Number(error.status) } : {}) };
  }
  if (Number(error?.status) === 404) return { ok: false, error: 'GITHUB_APP_INSTALLATION_NOT_FOUND', message: 'The GitHub App is not installed for this repository.', upstream_status: 404 };
  return { ok: false, error: error?.code || 'GITHUB_APP_AUTH_ERROR', message, ...(error?.status ? { upstream_status: Number(error.status) } : {}) };
}

export async function githubActionsStorageWithGitHubApp(input) {
  let normalized;
  try { normalized = normalizeGithubActionsStorageRequest(input); }
  catch (error) { return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}) }; }

  const profile = normalized.operation === 'inspect'
    ? 'actions_storage_read'
    : normalized.operation === 'delete_artifacts'
      ? 'actions_storage_delete'
      : 'actions_retention';
  try {
    return await withGitHubAppApiClient(normalized.repo, async (apiClient) => {
      if (normalized.operation === 'inspect') return inspectGithubActionsStorage(normalized, { apiClient });
      if (normalized.operation === 'delete_artifacts') return deleteGithubActionsArtifacts(normalized, { apiClient });
      return setGithubActionsRetention(normalized, { apiClient });
    }, { permissionProfile: profile });
  } catch (error) {
    return authFailure(error);
  }
}