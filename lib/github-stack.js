import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_STACK = 20;

export class GitHubStackError extends Error {
  constructor(code, message, details = null, httpStatus = null) {
    super(message);
    this.name = 'GitHubStackError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = null) {
  throw new GitHubStackError(code, message, details, httpStatus);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', `${field} must be an object`, { field }, 422);
  return value;
}

function exactFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', `${field} contains unknown fields`, { field, unknown }, 422);
}

function requiredString(value, field, max = null) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REQUEST', `${field} must be a non-empty string`, { field }, 422);
  const normalized = value.trim();
  if (max !== null && normalized.length > max) fail('INVALID_REQUEST', `${field} exceeds ${max} characters`, { field, max }, 422);
  return normalized;
}

export function normalizeGithubStackRequest(input) {
  const body = object(input, 'request');
  exactFields(body, new Set(['repo', 'pull_requests']), 'request');
  const repo = requiredString(body.repo, 'repo', 256);
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be owner/repo', { repo }, 422);
  if (!Array.isArray(body.pull_requests) || body.pull_requests.length < 2 || body.pull_requests.length > MAX_STACK) {
    fail('INVALID_REQUEST', `pull_requests must contain between 2 and ${MAX_STACK} ordered entries`, { field: 'pull_requests' }, 422);
  }
  const seen = new Set();
  const pullRequests = body.pull_requests.map((raw, index) => {
    const item = object(raw, `pull_requests[${index}]`);
    exactFields(item, new Set(['number', 'expected_head']), `pull_requests[${index}]`);
    const number = Number(item.number);
    if (!Number.isInteger(number) || number <= 0) fail('INVALID_REQUEST', `pull_requests[${index}].number must be a positive integer`, { index }, 422);
    if (seen.has(number)) fail('INVALID_REQUEST', 'pull_requests contains a duplicate pull request number', { number }, 422);
    seen.add(number);
    const expectedHead = requiredString(item.expected_head, `pull_requests[${index}].expected_head`, 40).toLowerCase();
    if (!SHA40.test(expectedHead)) fail('INVALID_SHA', 'expected_head must be a full 40-character hexadecimal Git commit SHA', { index }, 422);
    return { number, expected_head: expectedHead };
  });
  return { repo, pull_requests: pullRequests };
}

function encodePath(value) { return encodeURIComponent(String(value)); }

async function safeRead(apiClient, path, phase, options = {}) {
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.call('github', { path, method: 'GET' }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return { ok: false, error: 'GITHUB_UPSTREAM_ERROR', message: String(error?.message || 'GitHub read transport failed.'), phase, github_path: path, attempts: Number(error?.githubTransportAttempts || 1), may_have_mutated: false };
  }
  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300) {
    const status = Number(response?.status || 0);
    return {
      ok: false,
      error: status === 404 ? 'GITHUB_NOT_FOUND' : (status === 401 || status === 403 ? 'GITHUB_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR'),
      message: String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`),
      ...(status ? { upstream_status: status } : {}),
      ...githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }),
    };
  }
  return { ok: true, body: response.body, evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }) };
}

async function readPullRequest(apiClient, repo, number, options = {}) {
  const [owner, name] = repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(name)}/pulls/${number}`;
  const result = await safeRead(apiClient, path, `inspect.pull_request.${number}`, options);
  if (!result.ok) return result;
  return { ok: true, pr: result.body, evidence: result.evidence };
}

function stackNumber(pr) {
  const value = Number(pr?.stack?.number || 0);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function validateTopology(normalized, prs) {
  for (let i = 0; i < prs.length; i += 1) {
    const pr = prs[i];
    const expected = normalized.pull_requests[i];
    const actualHead = String(pr?.head?.sha || '').toLowerCase();
    if (actualHead !== expected.expected_head) {
      return { ok: false, error: 'HEAD_MISMATCH', message: `Pull request #${expected.number} head moved.`, pull_request: expected.number, expected_head: expected.expected_head, actual_head: actualHead || null, phase: 'inspect.pull_requests' };
    }
    const headRepo = String(pr?.head?.repo?.full_name || '');
    const baseRepo = String(pr?.base?.repo?.full_name || '');
    if (headRepo !== normalized.repo || baseRepo !== normalized.repo) {
      return { ok: false, error: 'GITHUB_STACK_TOPOLOGY_INVALID', message: 'Portfolio stacks must use branches in one repository; fork-based layers are not accepted.', pull_request: expected.number, head_repo: headRepo || null, base_repo: baseRepo || null, phase: 'inspect.pull_requests' };
    }
    if (String(pr?.state || '') !== 'open' && !pr?.merged_at) {
      return { ok: false, error: 'GITHUB_STACK_TOPOLOGY_INVALID', message: `Pull request #${expected.number} is closed without merge and cannot be admitted to a stack.`, pull_request: expected.number, phase: 'inspect.pull_requests' };
    }
    if (i > 0) {
      const priorHeadRef = String(prs[i - 1]?.head?.ref || '');
      const baseRef = String(pr?.base?.ref || '');
      if (!priorHeadRef || baseRef !== priorHeadRef) {
        return { ok: false, error: 'GITHUB_STACK_TOPOLOGY_INVALID', message: `Pull request #${expected.number} does not target the head branch of the layer below it.`, pull_request: expected.number, expected_base_ref: priorHeadRef || null, actual_base_ref: baseRef || null, phase: 'inspect.pull_requests' };
      }
    }
  }
  return { ok: true };
}

function orderedNumbers(stack) {
  return Array.isArray(stack?.pull_requests) ? stack.pull_requests.map((pr) => Number(pr?.number || 0)).filter((n) => n > 0) : [];
}

async function readStack(apiClient, repo, number, options = {}, phase = 'verify.stack') {
  const [owner, name] = repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(name)}/stacks/${number}`;
  const result = await safeRead(apiClient, path, phase, options);
  if (!result.ok) return result;
  return { ok: true, stack: result.body, evidence: result.evidence };
}

function errorResult(error) {
  if (error instanceof GitHubStackError) return { ok: false, error: error.code, message: error.message, ...(error.details || {}), ...(error.httpStatus ? { status: error.httpStatus } : {}) };
  return { ok: false, error: error?.code || 'INTERNAL_ERROR', message: String(error?.message || error || 'Unexpected stack reconciliation failure.') };
}

async function reconcileNormalized(normalized, apiClient, options = {}) {
  const evidence = [];
  const prs = [];
  for (const requested of normalized.pull_requests) {
    const read = await readPullRequest(apiClient, normalized.repo, requested.number, options);
    if (!read.ok) return read;
    evidence.push(read.evidence);
    prs.push(read.pr);
  }
  const topology = validateTopology(normalized, prs);
  if (!topology.ok) return topology;

  const memberships = [...new Set(prs.map(stackNumber).filter(Boolean))];
  if (memberships.length > 1 || (memberships.length === 1 && prs.some((pr) => !stackNumber(pr)))) {
    return { ok: false, error: 'GITHUB_STACK_CONFLICT', message: 'The requested pull requests have conflicting or partial existing stack membership.', stack_numbers: memberships, phase: 'inspect.stack_membership' };
  }

  const wanted = normalized.pull_requests.map((item) => item.number);
  if (memberships.length === 1) {
    const existing = await readStack(apiClient, normalized.repo, memberships[0], options, 'inspect.stack');
    if (!existing.ok) return existing;
    evidence.push(existing.evidence);
    const actual = orderedNumbers(existing.stack);
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      return { ok: false, error: 'GITHUB_STACK_CONFLICT', message: 'The existing GitHub stack composition differs from the requested ordered pull requests. This command does not destructively restructure a live stack.', stack_number: memberships[0], requested_pull_requests: wanted, actual_pull_requests: actual, phase: 'inspect.stack' };
    }
    return { ok: true, outcome: 'already_compliant', repo: normalized.repo, stack_number: memberships[0], pull_requests: wanted, changed: false, verified: true, github_evidence: evidence };
  }

  // Re-read exact PR heads and topology immediately before the mutating request.
  const pre = [];
  for (const requested of normalized.pull_requests) {
    const read = await readPullRequest(apiClient, normalized.repo, requested.number, options);
    if (!read.ok) return read;
    evidence.push(read.evidence);
    pre.push(read.pr);
  }
  const preTopology = validateTopology(normalized, pre);
  if (!preTopology.ok) return preTopology;
  if (pre.some((pr) => stackNumber(pr))) {
    return { ok: false, error: 'GITHUB_STACK_CONFLICT', message: 'Stack membership changed before stack creation.', phase: 'precondition.stack_membership' };
  }

  const [owner, name] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(name)}/stacks`;
  let response;
  try {
    response = await apiClient.call('github', { path, method: 'POST', body: { pull_requests: wanted } });
  } catch (error) {
    return { ok: false, error: 'GITHUB_STACK_INDETERMINATE', message: String(error?.message || 'GitHub stack creation transport failed after dispatch.'), repo: normalized.repo, pull_requests: wanted, phase: 'mutate.stack_create', github_path: path, attempts: 1, may_have_mutated: true };
  }
  if (!response || response.status < 200 || response.status >= 300) {
    const status = Number(response?.status || 0);
    const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
    if (status === 409) return { ok: false, error: 'GITHUB_STACK_CONFLICT', message, upstream_status: status, phase: 'mutate.stack_create', may_have_mutated: false };
    if (status === 422) return { ok: false, error: 'GITHUB_STACK_UNSUPPORTED', message, upstream_status: status, phase: 'mutate.stack_create', may_have_mutated: false };
    return { ok: false, error: status === 401 || status === 403 ? 'GITHUB_PERMISSION_DENIED' : 'GITHUB_STACK_INDETERMINATE', message, ...(status ? { upstream_status: status } : {}), phase: 'mutate.stack_create', may_have_mutated: true };
  }
  evidence.push(githubTransportEvidence(response, { phase: 'mutate.stack_create', path, attempts: 1, mayHaveMutated: true }));
  const number = Number(response.body?.number || 0);
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, error: 'GITHUB_STACK_INDETERMINATE', message: 'GitHub created a stack but did not return a valid stack number.', repo: normalized.repo, pull_requests: wanted, phase: 'mutate.stack_create', may_have_mutated: true, github_evidence: evidence };
  }

  const after = await readStack(apiClient, normalized.repo, number, options, 'verify.stack');
  if (!after.ok) return { ...after, error: 'GITHUB_STACK_INDETERMINATE', message: 'GitHub accepted stack creation but authoritative readback failed.', stack_number: number, may_have_mutated: true, github_evidence: evidence };
  evidence.push(after.evidence);
  const actual = orderedNumbers(after.stack);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    return { ok: false, error: 'GITHUB_STACK_INDETERMINATE', message: 'GitHub accepted stack creation but readback composition differs from the requested stack.', stack_number: number, requested_pull_requests: wanted, actual_pull_requests: actual, phase: 'verify.stack', may_have_mutated: true, github_evidence: evidence };
  }
  return { ok: true, outcome: 'created', repo: normalized.repo, stack_number: number, pull_requests: wanted, changed: true, verified: true, github_evidence: evidence };
}

export async function reconcileGithubStack(input, options = {}) {
  try {
    const normalized = normalizeGithubStackRequest(input);
    if (!options.apiClient) fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub API transport is required.', null, 500);
    return await reconcileNormalized(normalized, options.apiClient, options);
  } catch (error) { return errorResult(error); }
}

export async function reconcileGithubStackWithGitHubApp(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubStackRequest(input); }
  catch (error) { return errorResult(error); }
  try {
    return await withGitHubAppApiClient(normalized.repo, async (apiClient) => reconcileNormalized(normalized, apiClient, options), { permissionProfile: 'stack_reconcile' });
  } catch (error) {
    const message = String(error?.message || 'GitHub App authentication failed.');
    const setupRequired = /config\/get 412|declared as required but not set/i.test(message);
    if (setupRequired) return { ok: false, error: 'GITHUB_APP_SETUP_REQUIRED', message: 'Configure the GitHub App ID and private key in Hatchable Setup before using this command.' };
    if (Number(error?.status) === 404) return { ok: false, error: 'GITHUB_APP_INSTALLATION_NOT_FOUND', message: 'The GitHub App is not installed for this repository.', upstream_status: 404 };
    if (Number(error?.status) === 401 || Number(error?.status) === 403) return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message, upstream_status: Number(error.status), required_permissions: { pull_requests: 'write' } };
    return { ok: false, error: error?.code || 'GITHUB_APP_AUTH_ERROR', message, ...(error?.status ? { upstream_status: Number(error.status) } : {}) };
  }
}