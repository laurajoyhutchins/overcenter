import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_CHANGED_PATHS = 500;
const MAX_REVIEW_THREADS = 1000;
const MAX_THREAD_METADATA = 50;
const MAX_CHECK_RUNS = 1000;
const MAX_STATUSES = 1000;
const MAX_RULES = 1000;
const PAGE_SIZE = 100;
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILING_CHECK_CONCLUSIONS = new Set([
  'failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale',
]);

export const githubReviewPacketEvidencePolicy = Object.freeze({
  coherence_required: Object.freeze([
    'repository_identity',
    'pull_request_identity',
    'head_identity',
    'base_identity',
    'final_identity_reread',
  ]),
  required_observation: Object.freeze([
    'review_state',
    'changed_paths',
  ]),
  optional_evidence: Object.freeze([
    'check_runs',
    'commit_statuses',
    'rulesets',
    'classic_branch_protection',
  ]),
});

export class GitHubReviewPacketError extends Error {
  constructor(code, message, details = null, httpStatus = null) {
    super(message);
    this.name = 'GitHubReviewPacketError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = null) {
  throw new GitHubReviewPacketError(code, message, details, httpStatus);
}

function optionalEvidenceUnavailable(surface, error, { required_permission = null } = {}) {
  const code = String(error?.code || '');
  const message = String(error?.message || `${surface} evidence is unavailable.`);
  const status = Number(error?.details?.status || error?.status || error?.httpStatus || 0);

  let reason = null;
  let stableError = code || null;
  if (code === 'GITHUB_PERMISSION_DENIED') {
    reason = 'permission_denied';
  } else if (code === 'GITHUB_NOT_FOUND') {
    reason = 'unsupported';
  } else if (code === 'GITHUB_UPSTREAM_ERROR' && (status >= 500 || error?.httpStatus === 502)) {
    reason = 'upstream_unavailable';
  } else if (code) {
    return null;
  } else if ([401, 403].includes(status)
      || (status === 422 && /permission|not granted|resource not accessible/i.test(message))) {
    reason = 'permission_denied';
    stableError = 'GITHUB_APP_PERMISSION_DENIED';
  } else if (status === 404) {
    reason = 'unsupported';
    stableError = 'GITHUB_NOT_FOUND';
  } else if (status >= 500) {
    reason = 'upstream_unavailable';
    stableError = 'GITHUB_UPSTREAM_ERROR';
  } else {
    return null;
  }

  return {
    reason,
    error: stableError,
    message,
    ...(required_permission ? { required_permission } : {}),
    ...(status ? { upstream_status: status } : {}),
  };
}

async function collectOptionalEvidence(surface, operation, options = {}) {
  try {
    return { available: true, value: await operation() };
  } catch (error) {
    const unavailable = optionalEvidenceUnavailable(surface, error, options);
    if (!unavailable) throw error;
    return { available: false, unavailable };
  }
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REQUEST', `${field} must be an object`, { field }, 422);
  }
  return value;
}

function exactFields(value, allowed, field) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', `${field} contains unknown fields`, { field, unknown }, 422);
}

function validateRepo(value) {
  if (typeof value !== 'string' || !REPO.test(value) || value.length > 256) {
    fail('INVALID_REPOSITORY', 'repo must be exactly owner/repo', { repo: value ?? null }, 422);
  }
  return value;
}

function validatePullRequest(value) {
  if (!Number.isInteger(value) || value <= 0) {
    fail('INVALID_PULL_REQUEST', 'pull_request must be a positive integer', { pull_request: value ?? null }, 422);
  }
  return value;
}

function validateSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{40}$/.test(value)) {
    fail('INVALID_SHA', 'expected_head must be a full 40-character hexadecimal Git commit SHA', { field: 'expected_head' }, 422);
  }
  return value.toLowerCase();
}

export function normalizeGithubReviewPacketRequest(input) {
  const body = object(input, 'request');
  exactFields(body, new Set(['repo', 'pull_request', 'expected_head']), 'request');
  return {
    repo: validateRepo(body.repo),
    pull_request: validatePullRequest(body.pull_request),
    expected_head: body.expected_head === undefined || body.expected_head === null
      ? null
      : validateSha(body.expected_head),
  };
}

function upstreamMessage(body) {
  if (body && typeof body === 'object' && body.message) return String(body.message);
  if (typeof body === 'string' && body.trim()) return body.trim();
  return null;
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function repoPath(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encode(owner)}/${encode(name)}`;
}

function normalizeRestError(status, body, path) {
  const message = upstreamMessage(body) || `GitHub API returned HTTP ${status || 'unknown'}`;
  const details = {
    status: status || null,
    github_message: message,
    documentation_url: body?.documentation_url || null,
    github_path: path,
  };
  if (status === 401 || status === 403) {
    fail('GITHUB_PERMISSION_DENIED', message, details, 403);
  }
  if (status === 404) fail('GITHUB_NOT_FOUND', message, details, 404);
  fail('GITHUB_UPSTREAM_ERROR', message, details, status >= 500 ? 502 : (status || 502));
}

export function createGithubReviewApiAdapter(apiClient) {
  if (!apiClient || typeof apiClient.call !== 'function') {
    fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub API transport is required.', null, 500);
  }

  async function rest(method, path, { query, allow404 = false } = {}) {
    const response = await apiClient.call('github', {
      method,
      path,
      ...(query ? { query } : {}),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'Hatchable-Portfolio-Control-Plane/1.0',
      },
    });
    const status = Number(response?.status || 0);
    if (status >= 200 && status < 300) return { status, body: response.body, headers: response.headers || {} };
    if (allow404 && status === 404) return null;
    normalizeRestError(status, response?.body, path);
  }

  async function graphql(query, variables) {
    if (typeof apiClient.graphql !== 'function') {
      fail('GITHUB_TRANSPORT_UNAVAILABLE', 'GitHub GraphQL transport is required for review-thread inspection.', null, 500);
    }
    const response = await apiClient.graphql(query, variables);
    const status = Number(response?.status || 0);
    if (status < 200 || status >= 300) normalizeRestError(status, response?.body, '/graphql');
    if (Array.isArray(response?.body?.errors) && response.body.errors.length) {
      const message = String(response.body.errors[0]?.message || 'GitHub GraphQL returned an error.');
      const forbidden = /forbidden|resource not accessible|permission/i.test(message);
      fail(forbidden ? 'GITHUB_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR', message, {
        status,
        github_path: '/graphql',
        graphql_error_count: response.body.errors.length,
      }, forbidden ? 403 : 502);
    }
    return response?.body?.data;
  }

  async function getPullRequest(repo, pullNumber) {
    const { body } = await rest('GET', `${repoPath(repo)}/pulls/${pullNumber}`);
    const baseSha = String(body?.base?.sha || '').toLowerCase();
    const headSha = String(body?.head?.sha || '').toLowerCase();
    if (!SHA40.test(baseSha) || !SHA40.test(headSha) || !body?.base?.ref || !body?.head?.ref) {
      fail('GITHUB_INVALID_RESPONSE', 'GitHub pull request response did not contain exact base/head identity.', null, 502);
    }
    const headRepo = body?.head?.repo?.full_name ? String(body.head.repo.full_name) : null;
    return {
      state: String(body.state || '').toLowerCase(),
      draft: Boolean(body.draft),
      merged: Boolean(body.merged),
      base: { ref: String(body.base.ref), sha: baseSha },
      head: { ref: String(body.head.ref), sha: headSha, repo: headRepo },
      cross_repository: headRepo ? headRepo.toLowerCase() !== repo.toLowerCase() : true,
      merge: {
        mergeable: typeof body.mergeable === 'boolean' ? body.mergeable : null,
        merge_state: body.mergeable_state ? String(body.mergeable_state) : 'unknown',
      },
      changed_file_count: Number.isInteger(body.changed_files) ? body.changed_files : null,
    };
  }

  async function getReviewState(repo, pullNumber) {
    const [owner, name] = repo.split('/');
    let cursor = null;
    let pages = 0;
    let observedUnresolved = 0;
    const metadata = [];
    let decision = null;
    let complete = true;

    while (true) {
      const data = await graphql(`
        query ReviewPacket($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewDecision
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  path
                  line
                  startLine
                  comments(first: 1) {
                    nodes { author { login } url }
                  }
                }
              }
            }
          }
        }
      `, { owner, name, number: pullNumber, cursor });
      const pr = data?.repository?.pullRequest;
      if (!pr) fail('GITHUB_NOT_FOUND', 'GitHub GraphQL did not return the pull request.', null, 404);
      if (pages === 0) decision = pr.reviewDecision || null;
      const connection = pr.reviewThreads;
      if (!connection || !Array.isArray(connection.nodes)) {
        fail('GITHUB_INVALID_RESPONSE', 'GitHub GraphQL reviewThreads response was incomplete.', null, 502);
      }
      pages += 1;
      for (const thread of connection.nodes) {
        if (thread?.isResolved) continue;
        observedUnresolved += 1;
        if (metadata.length < MAX_THREAD_METADATA) {
          const comment = thread?.comments?.nodes?.[0] || null;
          metadata.push({
            id: String(thread?.id || ''),
            path: thread?.path ? String(thread.path) : null,
            line: Number.isInteger(thread?.line) ? thread.line : null,
            start_line: Number.isInteger(thread?.startLine) ? thread.startLine : null,
            author: comment?.author?.login ? String(comment.author.login) : null,
            url: comment?.url ? String(comment.url) : null,
          });
        }
      }
      const seen = pages * PAGE_SIZE;
      if (!connection.pageInfo?.hasNextPage) break;
      if (seen >= MAX_REVIEW_THREADS || !connection.pageInfo?.endCursor) {
        complete = false;
        break;
      }
      cursor = connection.pageInfo.endCursor;
    }

    metadata.sort((a, b) => a.id.localeCompare(b.id));
    return {
      decision,
      unresolved_thread_count: complete ? observedUnresolved : null,
      observed_unresolved_thread_count: complete ? undefined : observedUnresolved,
      threads_complete: complete,
      unresolved_threads: metadata,
      unresolved_threads_complete: complete && observedUnresolved <= MAX_THREAD_METADATA,
    };
  }

  async function listCheckRuns(repo, sha) {
    const items = [];
    let page = 1;
    let totalCount = null;
    let complete = true;
    while (items.length < MAX_CHECK_RUNS) {
      const { body } = await rest('GET', `${repoPath(repo)}/commits/${sha}/check-runs`, {
        query: { per_page: PAGE_SIZE, page, filter: 'latest' },
      });
      if (!Array.isArray(body?.check_runs)) {
        fail('GITHUB_INVALID_RESPONSE', 'GitHub check-runs response was incomplete.', null, 502);
      }
      if (Number.isInteger(body.total_count)) totalCount = body.total_count;
      const remaining = MAX_CHECK_RUNS - items.length;
      items.push(...body.check_runs.slice(0, remaining));
      if (body.check_runs.length < PAGE_SIZE) break;
      if (items.length >= MAX_CHECK_RUNS) {
        complete = totalCount !== null ? items.length >= totalCount : false;
        break;
      }
      page += 1;
    }
    if (totalCount !== null && items.length < totalCount) complete = false;
    return { items, complete, total_count: totalCount };
  }

  async function listStatuses(repo, sha) {
    const items = [];
    let page = 1;
    let complete = true;
    while (items.length < MAX_STATUSES) {
      const { body } = await rest('GET', `${repoPath(repo)}/statuses/${sha}`, {
        query: { per_page: PAGE_SIZE, page },
      });
      if (!Array.isArray(body)) fail('GITHUB_INVALID_RESPONSE', 'GitHub commit-status response was incomplete.', null, 502);
      const remaining = MAX_STATUSES - items.length;
      items.push(...body.slice(0, remaining));
      if (body.length < PAGE_SIZE) break;
      if (items.length >= MAX_STATUSES) {
        complete = false;
        break;
      }
      page += 1;
    }
    return { items, complete };
  }

  async function listChangedPaths(repo, pullNumber, declaredCount) {
    const paths = [];
    let page = 1;
    let exhausted = false;
    while (paths.length < MAX_CHANGED_PATHS) {
      const { body } = await rest('GET', `${repoPath(repo)}/pulls/${pullNumber}/files`, {
        query: { per_page: PAGE_SIZE, page },
      });
      if (!Array.isArray(body)) fail('GITHUB_INVALID_RESPONSE', 'GitHub changed-files response was incomplete.', null, 502);
      const remaining = MAX_CHANGED_PATHS - paths.length;
      for (const file of body.slice(0, remaining)) {
        if (typeof file?.filename !== 'string') fail('GITHUB_INVALID_RESPONSE', 'GitHub changed-files entry lacked filename.', null, 502);
        paths.push(file.filename);
      }
      if (body.length < PAGE_SIZE) { exhausted = true; break; }
      if (paths.length >= MAX_CHANGED_PATHS) break;
      page += 1;
    }
    const unique = [...new Set(paths)].sort();
    const count = Number.isInteger(declaredCount) ? declaredCount : unique.length;
    return {
      count,
      paths: unique,
      complete: exhausted && count === unique.length,
      limit: MAX_CHANGED_PATHS,
    };
  }

  async function listRulesForBranch(repo, branch) {
    const rules = [];
    let page = 1;
    let complete = true;
    while (rules.length < MAX_RULES) {
      const { body } = await rest('GET', `${repoPath(repo)}/rules/branches/${encode(branch)}`, {
        query: { per_page: PAGE_SIZE, page },
      });
      if (!Array.isArray(body)) fail('GITHUB_INVALID_RESPONSE', 'GitHub branch-rules response was incomplete.', null, 502);
      const remaining = MAX_RULES - rules.length;
      rules.push(...body.slice(0, remaining));
      if (body.length < PAGE_SIZE) break;
      if (rules.length >= MAX_RULES) { complete = false; break; }
      page += 1;
    }
    return { rules, complete };
  }

  async function getClassicBranchProtection(repo, branch) {
    const result = await rest('GET', `${repoPath(repo)}/branches/${encode(branch)}/protection`, { allow404: true });
    return result ? { configured: true, body: result.body } : { configured: false, body: null };
  }

  return {
    getPullRequest,
    getReviewState,
    listCheckRuns,
    listStatuses,
    listChangedPaths,
    listRulesForBranch,
    getClassicBranchProtection,
  };
}

function checkRunState(run) {
  if (run?.status !== 'completed') return 'pending';
  const conclusion = run?.conclusion ? String(run.conclusion).toLowerCase() : null;
  if (PASSING_CHECK_CONCLUSIONS.has(conclusion)) return 'passing';
  if (FAILING_CHECK_CONCLUSIONS.has(conclusion)) return 'failing';
  return 'pending';
}

function statusState(status) {
  const value = String(status?.state || '').toLowerCase();
  if (value === 'success') return 'passing';
  if (value === 'failure' || value === 'error') return 'failing';
  return 'pending';
}

function normalizeChecks(checkRuns, statuses) {
  const checkRunsAvailable = checkRuns?.available !== false;
  const statusesAvailable = statuses?.available !== false;
  const checkRunItems = checkRunsAvailable ? (checkRuns?.items || []) : [];
  const statusItems = statusesAvailable ? (statuses?.items || []) : [];
  const items = [];
  for (const run of checkRunItems) {
    items.push({
      kind: 'check_run',
      name: String(run?.name || ''),
      state: checkRunState(run),
      status: run?.status ? String(run.status) : null,
      conclusion: run?.conclusion ? String(run.conclusion) : null,
      app: run?.app?.slug ? String(run.app.slug) : (run?.app?.name ? String(run.app.name) : null),
      app_id: Number.isInteger(run?.app?.id) ? run.app.id : null,
      id: run?.id ?? null,
      url: run?.html_url ? String(run.html_url) : null,
    });
  }

  const latestStatuses = new Map();
  for (const status of statusItems) {
    const name = String(status?.context || '');
    if (!name || latestStatuses.has(name)) continue;
    latestStatuses.set(name, status);
  }
  for (const [name, status] of latestStatuses) {
    items.push({
      kind: 'commit_status',
      name,
      state: statusState(status),
      status: status?.state ? String(status.state) : null,
      conclusion: null,
      app: status?.creator?.login ? String(status.creator.login) : null,
      app_id: null,
      id: status?.id ?? null,
      url: status?.target_url ? String(status.target_url) : null,
    });
  }

  items.sort((a, b) => `${a.name}\0${a.kind}\0${a.id ?? ''}`.localeCompare(`${b.name}\0${b.kind}\0${b.id ?? ''}`));
  const namesByState = state => [...new Set(items.filter(item => item.state === state).map(item => item.name))].sort();
  const passing = namesByState('passing');
  const pending = namesByState('pending');
  const failing = namesByState('failing');
  const fullyAvailable = checkRunsAvailable && statusesAvailable;
  const rollup = fullyAvailable
    ? (failing.length ? 'FAILURE' : (pending.length ? 'PENDING' : (items.length ? 'SUCCESS' : 'NONE')))
    : null;
  return {
    available: fullyAvailable,
    rollup_state: rollup,
    passing,
    pending,
    failing,
    items,
    enumeration_complete: Boolean(
      fullyAvailable && checkRuns.complete && statuses.complete,
    ),
    sources: {
      check_runs: {
        available: checkRunsAvailable,
        complete: checkRunsAvailable ? Boolean(checkRuns.complete) : false,
        unavailable: checkRunsAvailable ? null : (checkRuns.unavailable || null),
      },
      commit_statuses: {
        available: statusesAvailable,
        complete: statusesAvailable ? Boolean(statuses.complete) : false,
        unavailable: statusesAvailable ? null : (statuses.unavailable || null),
      },
    },
  };
}

function normalizeRuleRequirements(ruleResult) {
  if (!ruleResult || ruleResult.available === false) {
    return {
      available: false,
      configured: null,
      complete: false,
      required_checks: [],
      strict_required_status_checks: null,
      pull_request_rules: [],
      unassessed_rule_types: [],
      unavailable: ruleResult?.unavailable || {
        reason: 'indeterminate',
        error: 'GITHUB_UPSTREAM_ERROR',
        message: 'Ruleset policy evidence was not established.',
      },
    };
  }

  const requiredChecks = [];
  const pullRequestRules = [];
  const unassessed = new Set();
  let strictRequiredStatusChecks = false;
  let configured = false;
  for (const rule of ruleResult.rules || []) {
    const type = String(rule?.type || 'unknown');
    configured = true;
    if (type === 'required_status_checks') {
      strictRequiredStatusChecks = strictRequiredStatusChecks
        || Boolean(rule?.parameters?.strict_required_status_checks_policy);
      for (const check of rule?.parameters?.required_status_checks || []) {
        if (!check?.context) continue;
        requiredChecks.push({
          context: String(check.context),
          app_id: Number.isInteger(check.integration_id) ? check.integration_id : null,
          source: 'ruleset',
        });
      }
      continue;
    }
    if (type === 'pull_request') {
      pullRequestRules.push({
        required_approvals: Number.isInteger(rule?.parameters?.required_approving_review_count)
          ? rule.parameters.required_approving_review_count : 0,
        require_code_owner_review: Boolean(rule?.parameters?.require_code_owner_review),
        require_last_push_approval: Boolean(rule?.parameters?.require_last_push_approval),
        require_thread_resolution: Boolean(rule?.parameters?.required_review_thread_resolution),
        required_reviewers_present: Array.isArray(rule?.parameters?.required_reviewers)
          && rule.parameters.required_reviewers.some(item => Number(item?.minimum_approvals || 0) > 0),
      });
      continue;
    }
    if (!['creation', 'deletion', 'non_fast_forward'].includes(type)) unassessed.add(type);
  }
  return {
    available: true,
    configured,
    complete: Boolean(ruleResult.complete),
    required_checks: requiredChecks,
    strict_required_status_checks: strictRequiredStatusChecks,
    pull_request_rules: pullRequestRules,
    unassessed_rule_types: [...unassessed].sort(),
    unavailable: null,
  };
}

function normalizeClassicProtection(result) {
  if (!result || result.available === false) {
    return {
      available: false,
      configured: null,
      required_checks: [],
      strict_required_status_checks: null,
      required_approvals: null,
      require_code_owner_review: null,
      require_last_push_approval: null,
      require_thread_resolution: null,
      unavailable: result?.unavailable || {
        reason: 'not_requested',
        required_permission: { administration: 'read' },
      },
    };
  }
  if (!result.configured) {
    return {
      available: true,
      configured: false,
      required_checks: [],
      strict_required_status_checks: false,
      required_approvals: 0,
      require_code_owner_review: false,
      require_last_push_approval: false,
      require_thread_resolution: false,
      unavailable: null,
    };
  }
  const body = result.body || {};
  const checks = [];
  const statusChecks = body.required_status_checks || null;
  if (Array.isArray(statusChecks?.checks)) {
    for (const check of statusChecks.checks) {
      if (!check?.context) continue;
      checks.push({
        context: String(check.context),
        app_id: Number.isInteger(check.app_id) ? check.app_id : null,
        source: 'branch_protection',
      });
    }
  } else if (Array.isArray(statusChecks?.contexts)) {
    for (const context of statusChecks.contexts) {
      checks.push({ context: String(context), app_id: null, source: 'branch_protection' });
    }
  }
  const reviews = body.required_pull_request_reviews || null;
  return {
    available: true,
    configured: true,
    required_checks: checks,
    strict_required_status_checks: Boolean(statusChecks?.strict),
    required_approvals: reviews && Number.isInteger(reviews.required_approving_review_count)
      ? reviews.required_approving_review_count : 0,
    require_code_owner_review: Boolean(reviews?.require_code_owner_reviews),
    require_last_push_approval: Boolean(reviews?.require_last_push_approval),
    require_thread_resolution: Boolean(body?.required_conversation_resolution?.enabled),
    unavailable: null,
  };
}

function dedupeRequiredChecks(checks) {
  const map = new Map();
  for (const check of checks) {
    const key = `${check.context}\0${check.app_id ?? ''}`;
    if (!map.has(key)) map.set(key, check);
  }
  return [...map.values()].sort((a, b) => `${a.context}\0${a.app_id ?? ''}`.localeCompare(`${b.context}\0${b.app_id ?? ''}`));
}

function evaluateRequiredChecks(checks, required, requiredSetComplete) {
  const byName = new Map();
  for (const item of checks.items) {
    if (!byName.has(item.name)) byName.set(item.name, []);
    byName.get(item.name).push(item);
  }
  const passing = [];
  const pending = [];
  const failing = [];
  const missing = [];
  const unobserved = [];
  for (const requirement of required) {
    const candidates = (byName.get(requirement.context) || []).filter(item => {
      if (requirement.app_id === null) return true;
      return item.kind === 'check_run' && item.app_id === requirement.app_id;
    });
    const label = requirement.app_id === null ? requirement.context : `${requirement.context}@app:${requirement.app_id}`;
    if (!candidates.length) {
      if (checks.enumeration_complete) missing.push(label);
      else unobserved.push(label);
      continue;
    }
    if (candidates.some(item => item.state === 'passing')) passing.push(label);
    else if (candidates.some(item => item.state === 'pending')) pending.push(label);
    else failing.push(label);
  }
  const knownFailure = pending.length > 0 || failing.length > 0 || missing.length > 0;
  return {
    required_contexts: required.map(item => item.app_id === null ? item.context : `${item.context}@app:${item.app_id}`),
    passing_required: passing,
    pending_required: pending,
    failing_required: failing,
    missing_required: missing,
    unobserved_required: unobserved,
    required_set_complete: requiredSetComplete,
    required_satisfied: knownFailure ? false : (requiredSetComplete ? true : null),
  };
}

function evaluatePolicy({ rules, classic, review, checks, merge }) {
  const ruleReview = rules.pull_request_rules || [];
  const ruleApprovals = ruleReview.map(item => item.required_approvals || 0);
  const policySourcesAvailable = rules.available && classic.available;
  const policySourcesComplete = policySourcesAvailable && rules.complete;
  const exactReviewPolicy = policySourcesComplete;
  const knownRequiredApprovals = Math.max(0, ...ruleApprovals, classic.required_approvals || 0);
  const extraReviewRequirements = [];
  if (ruleReview.some(item => item.require_code_owner_review) || classic.require_code_owner_review) extraReviewRequirements.push('code_owner_review');
  if (ruleReview.some(item => item.require_last_push_approval) || classic.require_last_push_approval) extraReviewRequirements.push('last_push_approval');
  if (ruleReview.some(item => item.required_reviewers_present)) extraReviewRequirements.push('required_reviewers');
  const hasReviewRequirement = knownRequiredApprovals > 0 || extraReviewRequirements.length > 0;
  const requiredApprovals = exactReviewPolicy ? knownRequiredApprovals : null;
  const approvalSatisfied = hasReviewRequirement
    ? (review.decision === 'APPROVED' ? true : false)
    : (exactReviewPolicy ? true : null);

  const requiredChecks = dedupeRequiredChecks([
    ...rules.required_checks,
    ...classic.required_checks,
  ]);
  const checkEvaluation = evaluateRequiredChecks(
    checks,
    requiredChecks,
    policySourcesComplete && checks.enumeration_complete,
  );

  const knownThreadRequirement = ruleReview.some(item => item.require_thread_resolution)
    || classic.require_thread_resolution === true;
  const threadRequired = knownThreadRequirement ? true : (policySourcesComplete ? false : null);
  const threadSatisfied = threadRequired === true
    ? (review.threads_complete ? review.unresolved_thread_count === 0 : null)
    : (threadRequired === false ? true : null);

  const knownBranchUpToDateRequirement = rules.strict_required_status_checks === true
    || classic.strict_required_status_checks === true;
  const branchUpToDateRequired = knownBranchUpToDateRequirement ? true : (policySourcesComplete ? false : null);
  const branchUpToDateSatisfied = branchUpToDateRequired === true
    ? (merge.merge_state === 'behind' ? false : (merge.merge_state === 'clean' ? true : null))
    : (branchUpToDateRequired === false ? true : null);

  const unsatisfied = [];
  if (hasReviewRequirement && approvalSatisfied === false) unsatisfied.push('required_reviews');
  if (checkEvaluation.required_satisfied === false) unsatisfied.push('required_status_checks');
  if (threadRequired && threadSatisfied === false) unsatisfied.push('conversation_resolution');
  if (branchUpToDateRequired && branchUpToDateSatisfied === false) unsatisfied.push('branch_up_to_date');

  const configured = rules.configured === true || classic.configured === true
    ? true
    : (policySourcesComplete && rules.configured === false && classic.configured === false ? false : null);
  const policyComplete = policySourcesComplete && checks.enumeration_complete && review.threads_complete
    && (branchUpToDateRequired !== true || branchUpToDateSatisfied !== null);
  let evaluation;
  if (unsatisfied.length) evaluation = 'unsatisfied';
  else if (!policySourcesAvailable) evaluation = 'unavailable';
  else if (configured === false) evaluation = 'not_configured';
  else if (!policyComplete || rules.unassessed_rule_types.length) evaluation = 'unknown';
  else evaluation = 'satisfied';

  return {
    review: {
      decision: review.decision,
      unresolved_thread_count: review.unresolved_thread_count,
      ...(review.observed_unresolved_thread_count !== undefined
        ? { observed_unresolved_thread_count: review.observed_unresolved_thread_count } : {}),
      threads_complete: review.threads_complete,
      unresolved_threads: review.unresolved_threads,
      unresolved_threads_complete: review.unresolved_threads_complete,
      changes_requested: review.decision === 'CHANGES_REQUESTED',
      required_approvals: requiredApprovals,
      approval_requirement_satisfied: approvalSatisfied,
      additional_review_requirements: extraReviewRequirements,
    },
    checks: {
      ...checks,
      ...checkEvaluation,
    },
    protection: {
      available: policySourcesAvailable,
      evaluation,
      source: rules.configured && classic.configured === true
        ? 'combined'
        : (rules.configured ? 'rulesets' : (classic.configured === true ? 'branch_protection' : 'none')),
      configured,
      unsatisfied_requirements: unsatisfied,
      thread_resolution_required: threadRequired,
      thread_resolution_satisfied: threadSatisfied,
      branch_up_to_date_required: branchUpToDateRequired,
      branch_up_to_date_satisfied: branchUpToDateSatisfied,
      unassessed_rule_types: rules.unassessed_rule_types,
      rulesets_complete: rules.complete,
      rulesets_available: rules.available,
      classic_branch_protection_available: classic.available,
      policy_surfaces: {
        rulesets: {
          available: rules.available,
          configured: rules.configured,
          complete: rules.complete,
          unavailable: rules.unavailable,
        },
        classic_branch_protection: {
          available: classic.available,
          configured: classic.configured,
          unavailable: classic.unavailable,
        },
      },
      ...(classic.unavailable ? { unavailable: classic.unavailable } : {}),
      ...(rules.unavailable ? { rulesets_unavailable: rules.unavailable } : {}),
      merge_state_observed: merge.merge_state,
    },
  };
}

function sameIdentity(a, b) {
  return a.head.sha === b.head.sha
    && a.base.sha === b.base.sha
    && a.head.ref === b.head.ref
    && a.base.ref === b.base.ref
    && a.head.repo === b.head.repo;
}

function errorResult(error) {
  if (!(error instanceof GitHubReviewPacketError)) throw error;
  return {
    ok: false,
    error: error.code,
    message: error.message,
    ...(error.details && typeof error.details === 'object' ? error.details : {}),
  };
}

export async function reviewGithubPullRequest(input, options = {}) {
  try {
    const normalized = normalizeGithubReviewPacketRequest(input);
    const github = options.github || createGithubReviewApiAdapter(options.apiClient);
    let initial = await github.getPullRequest(normalized.repo, normalized.pull_request);
    if (normalized.expected_head && normalized.expected_head !== initial.head.sha) {
      fail('HEAD_MISMATCH', 'expected_head does not match the pull request current head.', {
        expected_head: normalized.expected_head,
        actual_head: initial.head.sha,
      }, 409);
    }

    if (initial.merge.mergeable === null) {
      const refreshed = await github.getPullRequest(normalized.repo, normalized.pull_request);
      if (!sameIdentity(initial, refreshed)) {
        fail('HEAD_MOVED_DURING_INSPECTION', 'Pull request head/base changed during mergeability refresh.', {
          initial_head: initial.head.sha,
          current_head: refreshed.head.sha,
          initial_base: initial.base.sha,
          current_base: refreshed.base.sha,
        }, 409);
      }
      initial = { ...initial, merge: refreshed.merge };
    }

    const [reviewRaw, checkRunsCollection, statusesCollection, changedFiles, rulesCollection] = await Promise.all([
      github.getReviewState(normalized.repo, normalized.pull_request),
      collectOptionalEvidence(
        'check_runs',
        () => typeof options.checkRunsProvider === 'function'
          ? options.checkRunsProvider(initial.head.sha)
          : github.listCheckRuns(normalized.repo, initial.head.sha),
        { required_permission: { checks: 'read' } },
      ),
      collectOptionalEvidence(
        'commit_statuses',
        () => typeof options.statusesProvider === 'function'
          ? options.statusesProvider(initial.head.sha)
          : github.listStatuses(normalized.repo, initial.head.sha),
        { required_permission: { statuses: 'read' } },
      ),
      github.listChangedPaths(normalized.repo, normalized.pull_request, initial.changed_file_count),
      collectOptionalEvidence(
        'rulesets',
        () => github.listRulesForBranch(normalized.repo, initial.base.ref),
      ),
    ]);
    const checkRuns = checkRunsCollection.available
      ? { available: true, ...checkRunsCollection.value }
      : { available: false, unavailable: checkRunsCollection.unavailable };
    const statuses = statusesCollection.available
      ? { available: true, ...statusesCollection.value }
      : { available: false, unavailable: statusesCollection.unavailable };
    const rulesRaw = rulesCollection.available
      ? { available: true, ...rulesCollection.value }
      : { available: false, unavailable: rulesCollection.unavailable };

    let classicRaw;
    if (typeof options.protectionProvider === 'function') {
      const classicCollection = await collectOptionalEvidence(
        'classic_branch_protection',
        () => options.protectionProvider(initial.base.ref),
        { required_permission: { administration: 'read' } },
      );
      classicRaw = classicCollection.available
        ? classicCollection.value
        : { available: false, unavailable: classicCollection.unavailable };
    } else if (typeof github.getClassicBranchProtection === 'function' && options.classicProtection === true) {
      const classicCollection = await collectOptionalEvidence(
        'classic_branch_protection',
        () => github.getClassicBranchProtection(normalized.repo, initial.base.ref),
        { required_permission: { administration: 'read' } },
      );
      classicRaw = classicCollection.available
        ? classicCollection.value
        : { available: false, unavailable: classicCollection.unavailable };
    } else {
      classicRaw = {
        available: false,
        unavailable: {
          reason: 'unsupported',
          error: 'GITHUB_APP_PERMISSION_DENIED',
          message: 'Classic branch protection inspection was not requested for this adapter.',
          required_permission: { administration: 'read' },
        },
      };
    }

    const finalIdentity = await github.getPullRequest(normalized.repo, normalized.pull_request);
    if (!sameIdentity(initial, finalIdentity)) {
      fail('HEAD_MOVED_DURING_INSPECTION', 'Pull request head/base changed while the review packet was assembled.', {
        initial_head: initial.head.sha,
        current_head: finalIdentity.head.sha,
        initial_base: initial.base.sha,
        current_base: finalIdentity.base.sha,
      }, 409);
    }

    const rules = normalizeRuleRequirements(rulesRaw);
    const classic = normalizeClassicProtection(classicRaw);
    const normalizedChecks = normalizeChecks(checkRuns, statuses);
    const policy = evaluatePolicy({
      rules,
      classic,
      review: reviewRaw,
      checks: normalizedChecks,
      merge: initial.merge,
    });

    const observation = {
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      state: initial.state,
      draft: initial.draft,
      merged: initial.merged,
      base: initial.base,
      head: initial.head,
      cross_repository: initial.cross_repository,
      merge: initial.merge,
      review: policy.review,
      checks: policy.checks,
      protection: policy.protection,
      changed_files: changedFiles,
    };
    const digest = await sha256Text(canonicalJson(observation));
    return {
      ok: true,
      ...observation,
      snapshot: {
        head_sha: initial.head.sha,
        base_sha: initial.base.sha,
        observed_at: (options.now ? options.now() : new Date()).toISOString(),
        sha256: digest,
      },
    };
  } catch (error) {
    return errorResult(error);
  }
}

export function mapGithubReviewPacketAuthError(error, requiredPermissions) {
  const message = String(error?.message || 'GitHub App authentication failed.');
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
    };
  }
  if ([401, 403, 422].includes(Number(error?.status))) {
    return {
      ok: false,
      error: 'GITHUB_APP_PERMISSION_DENIED',
      message,
      upstream_status: Number(error.status),
      required_permissions: requiredPermissions,
    };
  }
  return {
    ok: false,
    error: error?.code || 'GITHUB_APP_AUTH_ERROR',
    message,
    ...(error?.status ? { upstream_status: Number(error.status) } : {}),
  };
}

export async function reviewGithubPullRequestWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubReviewPacketRequest(input);
  } catch (error) {
    return errorResult(error);
  }
  const basePermissions = {
    metadata: 'read',
    pull_requests: 'read',
  };
  try {
    return await withGitHubAppApiClient(normalized.repo, async (apiClient) => {
      const checkRunsProvider = async (headSha) => {
        return withGitHubAppApiClient(normalized.repo, async (checksClient) => {
          const adapter = createGithubReviewApiAdapter(checksClient);
          return adapter.listCheckRuns(normalized.repo, headSha);
        }, { permissionProfile: 'review_checks' });
      };
      const statusesProvider = async (headSha) => {
        return withGitHubAppApiClient(normalized.repo, async (statusesClient) => {
          const adapter = createGithubReviewApiAdapter(statusesClient);
          return adapter.listStatuses(normalized.repo, headSha);
        }, { permissionProfile: 'review_statuses' });
      };
      const protectionProvider = async (baseRef) => {
        try {
          return await withGitHubAppApiClient(normalized.repo, async (protectionClient) => {
            const adapter = createGithubReviewApiAdapter(protectionClient);
            return adapter.getClassicBranchProtection(normalized.repo, baseRef);
          }, { permissionProfile: 'review_protection' });
        } catch (error) {
          const unavailable = optionalEvidenceUnavailable('classic_branch_protection', error, {
            required_permission: { administration: 'read' },
          });
          if (!unavailable) throw error;
          return { available: false, unavailable };
        }
      };
      return reviewGithubPullRequest(normalized, {
        ...options,
        apiClient,
        checkRunsProvider,
        statusesProvider,
        protectionProvider,
      });
    }, { permissionProfile: 'review_packet' });
  } catch (error) {
    return mapGithubReviewPacketAuthError(error, basePermissions);
  }
}

export const githubReviewPacketLimits = Object.freeze({
  changed_paths: MAX_CHANGED_PATHS,
  review_threads: MAX_REVIEW_THREADS,
  unresolved_thread_metadata: MAX_THREAD_METADATA,
  check_runs: MAX_CHECK_RUNS,
  statuses: MAX_STATUSES,
  rules: MAX_RULES,
});