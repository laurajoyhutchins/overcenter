import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^[A-Za-z0-9._/+\-]+$/;
const ZERO_OID = '0000000000000000000000000000000000000000';

const PREFLIGHT_QUERY = `
query GitHubDeleteBranchPreflight($owner: String!, $name: String!, $qualifiedName: String!) {
  repository(owner: $owner, name: $name) {
    id
    defaultBranchRef { name }
    ref(qualifiedName: $qualifiedName) {
      name
      target { oid }
    }
  }
}`;

const DELETE_BRANCH_MUTATION = `
mutation GitHubDeleteBranch($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}`;

export class GitHubDeleteBranchError extends Error {
  constructor(code, message, details = null, httpStatus = null) {
    super(message);
    this.name = 'GitHubDeleteBranchError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = null) {
  throw new GitHubDeleteBranchError(code, message, details, httpStatus);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REQUEST', `${field} must be an object`, { field }, 422);
  }
  return value;
}

function exactFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', `${field} contains unknown fields`, { field, unknown }, 422);
}

function requiredString(value, field, max = null) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_REQUEST', `${field} must be a non-empty string`, { field }, 422);
  }
  if (max !== null && value.length > max) {
    fail('INVALID_REQUEST', `${field} exceeds ${max} characters`, { field, max }, 422);
  }
  return value;
}

function validateRepo(value) {
  const repo = requiredString(value, 'repo', 256);
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be owner/repo', { repo }, 422);
  return repo;
}

function validateSha(value) {
  const sha = requiredString(value, 'expected_head', 40).toLowerCase();
  if (!SHA40.test(sha)) {
    fail('INVALID_SHA', 'expected_head must be a full 40-character hexadecimal Git commit SHA', { field: 'expected_head' }, 422);
  }
  return sha;
}

function validateBranch(value) {
  const branch = requiredString(value, 'branch', 255);
  if (branch.startsWith('refs/')) {
    fail('INVALID_BRANCH', 'branch must be an unqualified branch name, not a refs/... name', { branch }, 422);
  }
  if (!SAFE_BRANCH.test(branch)
      || branch.startsWith('/')
      || branch.endsWith('/')
      || branch.endsWith('.')
      || branch.includes('..')
      || branch.includes('//')
      || branch.includes('@{')
      || branch.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.lock'))) {
    fail('INVALID_BRANCH', 'branch is not a safe Git branch name', { branch }, 422);
  }
  return branch;
}

export function normalizeGithubDeleteBranchRequest(input) {
  const body = object(input, 'request');
  exactFields(body, new Set(['repo', 'branch', 'expected_head']), 'request');
  return {
    repo: validateRepo(body.repo),
    branch: validateBranch(body.branch),
    expected_head: validateSha(body.expected_head),
  };
}

function graphqlErrors(response) {
  return Array.isArray(response?.body?.errors) ? response.body.errors : [];
}

function errorSummary(errors) {
  return errors.map((error) => ({
    message: String(error?.message || 'GitHub GraphQL error'),
    ...(error?.type ? { type: String(error.type) } : {}),
    ...(Array.isArray(error?.path) ? { path: error.path } : {}),
  }));
}

function transportFailure(response, phase, mayHaveMutated) {
  const evidence = githubTransportEvidence(response, {
    phase,
    path: '/graphql',
    attempts: 1,
    mayHaveMutated,
  });
  const status = Number(response?.status || 0);
  const message = response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`;
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: 'GITHUB_PERMISSION_DENIED',
      message: String(message),
      upstream_status: status,
      ...evidence,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      error: 'GITHUB_NOT_FOUND',
      message: 'The repository was not found.',
      upstream_status: status,
      ...evidence,
    };
  }
  return {
    ok: false,
    error: mayHaveMutated ? 'BRANCH_DELETE_INDETERMINATE' : 'GITHUB_UPSTREAM_ERROR',
    message: String(message),
    ...(status ? { upstream_status: status } : {}),
    ...evidence,
  };
}

async function preflight(apiClient, normalized, options = {}, phase = 'preflight') {
  const [owner, name] = normalized.repo.split('/');
  const qualifiedName = `refs/heads/${normalized.branch}`;
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.graphql(PREFLIGHT_QUERY, { owner, name, qualifiedName }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return {
      ok: false,
      error: 'GITHUB_UPSTREAM_ERROR',
      message: String(error?.message || 'GitHub preflight transport failed.'),
      phase,
      github_path: '/graphql',
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    };
  }

  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300) {
    const failure = transportFailure(response, phase, false);
    failure.attempts = retried.attempts;
    return failure;
  }

  const errors = graphqlErrors(response);
  if (errors.length) {
    const messages = errorSummary(errors);
    const forbidden = errors.some((error) => String(error?.type || '').toUpperCase() === 'FORBIDDEN');
    const notFound = errors.some((error) => /could not resolve|not found/i.test(String(error?.message || '')));
    return {
      ok: false,
      error: forbidden ? 'GITHUB_PERMISSION_DENIED' : (notFound ? 'GITHUB_NOT_FOUND' : 'GITHUB_UPSTREAM_ERROR'),
      message: messages[0]?.message || 'GitHub GraphQL preflight failed.',
      phase,
      github_path: '/graphql',
      attempts: retried.attempts,
      may_have_mutated: false,
      graphql_errors: messages,
    };
  }

  const repository = response.body?.data?.repository;
  if (!repository?.id) {
    return {
      ok: false,
      error: 'GITHUB_NOT_FOUND',
      message: 'The repository was not found.',
      phase,
      github_path: '/graphql',
      attempts: retried.attempts,
      may_have_mutated: false,
    };
  }

  const ref = repository.ref || null;
  const actualHead = ref?.target?.oid ? String(ref.target.oid).toLowerCase() : null;
  return {
    ok: true,
    repository_id: String(repository.id),
    default_branch: repository.defaultBranchRef?.name ? String(repository.defaultBranchRef.name) : null,
    actual_head: actualHead,
    branch_exists: Boolean(ref),
    attempts: retried.attempts,
  };
}

function errorResult(error) {
  if (error instanceof GitHubDeleteBranchError) {
    return {
      ok: false,
      error: error.code,
      message: error.message,
      ...(error.details || {}),
      ...(error.httpStatus ? { status: error.httpStatus } : {}),
    };
  }
  return {
    ok: false,
    error: error?.code || 'INTERNAL_ERROR',
    message: String(error?.message || error || 'Unexpected branch deletion failure.'),
  };
}

async function deleteNormalized(normalized, apiClient, options = {}) {
  const before = await preflight(apiClient, normalized, options, 'preflight');
  if (!before.ok) return before;

  if (!before.branch_exists) {
    return {
      ok: true,
      outcome: 'already_absent',
      repo: normalized.repo,
      branch: normalized.branch,
      expected_head: normalized.expected_head,
      deleted_head: null,
      precondition_verified: false,
      branch_absent: true,
    };
  }

  if (before.default_branch === normalized.branch) {
    return {
      ok: false,
      error: 'GITHUB_REF_REJECTED',
      message: 'The repository default branch cannot be deleted.',
      repo: normalized.repo,
      branch: normalized.branch,
      expected_head: normalized.expected_head,
      actual_head: before.actual_head,
      reason: 'default_branch',
      phase: 'preflight',
    };
  }

  if (!before.actual_head || !SHA40.test(before.actual_head)) {
    return {
      ok: false,
      error: 'GITHUB_INVALID_RESPONSE',
      message: 'GitHub returned a branch without a valid commit OID.',
      repo: normalized.repo,
      branch: normalized.branch,
      phase: 'preflight',
      may_have_mutated: false,
    };
  }

  if (before.actual_head !== normalized.expected_head) {
    return {
      ok: false,
      error: 'HEAD_MISMATCH',
      message: 'expected_head does not match the current branch head.',
      repo: normalized.repo,
      branch: normalized.branch,
      expected_head: normalized.expected_head,
      actual_head: before.actual_head,
      phase: 'preflight',
    };
  }

  const input = {
    repositoryId: before.repository_id,
    refUpdates: [{
      name: `refs/heads/${normalized.branch}`,
      beforeOid: normalized.expected_head,
      afterOid: ZERO_OID,
      force: false,
    }],
  };

  let response;
  try {
    response = await apiClient.graphql(DELETE_BRANCH_MUTATION, { input });
  } catch (error) {
    return {
      ok: false,
      error: 'BRANCH_DELETE_INDETERMINATE',
      message: String(error?.message || 'GitHub branch deletion transport failed after mutation dispatch.'),
      repo: normalized.repo,
      branch: normalized.branch,
      expected_head: normalized.expected_head,
      phase: 'delete',
      github_path: '/graphql',
      attempts: 1,
      may_have_mutated: true,
    };
  }

  if (!response || response.status < 200 || response.status >= 300) {
    const failure = transportFailure(response, 'delete', true);
    return {
      ...failure,
      repo: normalized.repo,
      branch: normalized.branch,
      expected_head: normalized.expected_head,
    };
  }

  const mutationErrors = graphqlErrors(response);
  if (mutationErrors.length) {
    const after = await preflight(apiClient, normalized, options, 'reconcile_after_rejection');
    if (after.ok) {
      if (!after.branch_exists) {
        return {
          ok: true,
          outcome: 'already_absent',
          repo: normalized.repo,
          branch: normalized.branch,
          expected_head: normalized.expected_head,
          deleted_head: null,
          precondition_verified: false,
          branch_absent: true,
          reconciled_after_rejection: true,
        };
      }
      if (after.actual_head !== normalized.expected_head) {
        return {
          ok: false,
          error: 'HEAD_MISMATCH',
          message: 'The branch head changed before GitHub could apply the conditional deletion.',
          repo: normalized.repo,
          branch: normalized.branch,
          expected_head: normalized.expected_head,
          actual_head: after.actual_head,
          phase: 'delete',
          graphql_errors: errorSummary(mutationErrors),
        };
      }
    }

    return {
      ok: false,
      error: 'GITHUB_REF_REJECTED',
      message: errorSummary(mutationErrors)[0]?.message || 'GitHub rejected the branch deletion.',
      repo: normalized.repo,
      branch: normalized.branch,
      expected_head: normalized.expected_head,
      actual_head: after.ok ? after.actual_head : before.actual_head,
      phase: 'delete',
      reason: 'github_policy_or_ref_rule',
      graphql_errors: errorSummary(mutationErrors),
      ...(after.ok ? {} : { reconciliation_error: after }),
    };
  }

  return {
    ok: true,
    outcome: 'deleted',
    repo: normalized.repo,
    branch: normalized.branch,
    expected_head: normalized.expected_head,
    deleted_head: normalized.expected_head,
    precondition_verified: true,
    atomic_compare_and_swap: true,
  };
}

export async function deleteGithubBranch(input, options = {}) {
  try {
    const normalized = normalizeGithubDeleteBranchRequest(input);
    if (!options.apiClient) {
      fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub API transport is required.', null, 500);
    }
    return await deleteNormalized(normalized, options.apiClient, options);
  } catch (error) {
    return errorResult(error);
  }
}

export async function deleteGithubBranchWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubDeleteBranchRequest(input);
  } catch (error) {
    return errorResult(error);
  }

  try {
    return await withGitHubAppApiClient(normalized.repo, async (apiClient) => {
      return deleteNormalized(normalized, apiClient, options);
    }, { permissionProfile: 'delete_branch' });
  } catch (error) {
    const message = String(error?.message || 'GitHub App authentication failed.');
    const transportEvidence = {
      ...(error?.phase ? { phase: error.phase } : {}),
      ...(error?.githubPath ? { github_path: error.githubPath } : {}),
      ...(error?.githubRequestId ? { github_request_id: error.githubRequestId } : {}),
      ...(error?.retryAfter ? { retry_after: error.retryAfter } : {}),
      ...(error?.attempts ? { attempts: Number(error.attempts) } : {}),
      ...(error?.mayHaveMutated !== undefined ? { may_have_mutated: Boolean(error.mayHaveMutated) } : {}),
    };
    const setupRequired = /config\/get 412|declared as required but not set/i.test(message);
    if (setupRequired) {
      return {
        ok: false,
        error: 'GITHUB_APP_SETUP_REQUIRED',
        message: 'Configure the GitHub App ID and private key in Hatchable Setup before using this command.',
      };
    }
    if (error?.code === 'INVALID_REPO' || error?.code === 'INVALID_GITHUB_APP_ID' || error?.code === 'INVALID_GITHUB_APP_PRIVATE_KEY') {
      return { ok: false, error: error.code, message };
    }
    if (Number(error?.status) === 404) {
      return {
        ok: false,
        error: 'GITHUB_APP_INSTALLATION_NOT_FOUND',
        message: 'The GitHub App is not installed for this repository.',
        upstream_status: 404,
        ...transportEvidence,
      };
    }
    if (Number(error?.status) === 401 || Number(error?.status) === 403) {
      return {
        ok: false,
        error: 'GITHUB_APP_PERMISSION_DENIED',
        message,
        upstream_status: Number(error.status),
        ...transportEvidence,
      };
    }
    return {
      ok: false,
      error: error?.code || 'GITHUB_APP_AUTH_ERROR',
      message,
      ...(error?.status ? { upstream_status: Number(error.status) } : {}),
      ...transportEvidence,
    };
  }
}