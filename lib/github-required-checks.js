import { canonicalJson } from 'lib/canonical-json.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^[A-Za-z0-9._/+\-]+$/;
const MAX_CHECKS = 50;

export class GitHubRequiredChecksError extends Error {
  constructor(code, message, details = null, httpStatus = null) {
    super(message);
    this.name = 'GitHubRequiredChecksError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = null) {
  throw new GitHubRequiredChecksError(code, message, details, httpStatus);
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
  if (typeof value !== 'string' || !value.trim()) {
    fail('INVALID_REQUEST', `${field} must be a non-empty string`, { field }, 422);
  }
  const normalized = value.trim();
  if (max !== null && normalized.length > max) {
    fail('INVALID_REQUEST', `${field} exceeds ${max} characters`, { field, max }, 422);
  }
  return normalized;
}

function validateRepo(value) {
  const repo = requiredString(value, 'repo', 256);
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be owner/repo', { repo }, 422);
  return repo;
}

function validateBranch(value) {
  const branch = requiredString(value, 'branch', 255);
  if (branch.startsWith('refs/')
      || !SAFE_BRANCH.test(branch)
      || branch.startsWith('/')
      || branch.endsWith('/')
      || branch.endsWith('.')
      || branch.includes('..')
      || branch.includes('//')
      || branch.includes('@{')
      || branch.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.lock'))) {
    fail('INVALID_BRANCH', 'branch is not a safe unqualified Git branch name', { branch }, 422);
  }
  return branch;
}

function validateSha(value) {
  const sha = requiredString(value, 'expected_head', 40).toLowerCase();
  if (!SHA40.test(sha)) {
    fail('INVALID_SHA', 'expected_head must be a full 40-character hexadecimal Git commit SHA', { field: 'expected_head' }, 422);
  }
  return sha;
}

function validateChecks(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECKS) {
    fail('INVALID_REQUEST', `required_checks must contain between 1 and ${MAX_CHECKS} entries`, { field: 'required_checks' }, 422);
  }
  const checks = value.map((item, index) => requiredString(item, `required_checks[${index}]`, 256));
  const seen = new Set();
  for (const check of checks) {
    if (seen.has(check)) fail('INVALID_REQUEST', 'required_checks contains a duplicate name', { check }, 422);
    seen.add(check);
  }
  return checks;
}

export function normalizeGithubRequiredChecksRequest(input) {
  const body = object(input, 'request');
  exactFields(body, new Set(['repo', 'branch', 'expected_head', 'required_checks']), 'request');
  return {
    repo: validateRepo(body.repo),
    branch: validateBranch(body.branch),
    expected_head: validateSha(body.expected_head),
    required_checks: validateChecks(body.required_checks),
  };
}

function encodePath(value) {
  return encodeURIComponent(String(value));
}

function transportFailure(response, phase, path, mayHaveMutated = false) {
  const evidence = githubTransportEvidence(response, { phase, path, attempts: 1, mayHaveMutated });
  const status = Number(response?.status || 0);
  const upstreamMessage = response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`;
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: 'GITHUB_APP_PERMISSION_DENIED',
      message: String(upstreamMessage),
      upstream_status: status,
      required_permissions: { administration: 'write', checks: 'read' },
      ...evidence,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      error: 'GITHUB_NOT_FOUND',
      message: String(upstreamMessage),
      upstream_status: status,
      ...evidence,
    };
  }
  if (status === 422 && mayHaveMutated) {
    return {
      ok: false,
      error: 'GITHUB_REQUIRED_CHECKS_UNSUPPORTED',
      message: String(upstreamMessage),
      upstream_status: status,
      ...evidence,
    };
  }
  return {
    ok: false,
    error: 'GITHUB_UPSTREAM_ERROR',
    message: String(upstreamMessage),
    ...(status ? { upstream_status: status } : {}),
    ...evidence,
  };
}

async function safeRead(apiClient, path, phase, options = {}, allow404 = false) {
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.call('github', { path, method: 'GET' }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return {
      ok: false,
      error: 'GITHUB_UPSTREAM_ERROR',
      message: String(error?.message || 'GitHub read transport failed.'),
      phase,
      github_path: path,
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    };
  }
  const response = retried.response;
  if (allow404 && Number(response?.status) === 404) {
    return {
      ok: true,
      found: false,
      body: null,
      evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }),
    };
  }
  if (!response || response.status < 200 || response.status >= 300) {
    const failure = transportFailure(response, phase, path, false);
    failure.attempts = retried.attempts;
    return failure;
  }
  return {
    ok: true,
    found: true,
    body: response.body,
    evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }),
  };
}

async function writeRequest(apiClient, path, method, body, phase) {
  let response;
  try {
    response = await apiClient.call('github', { path, method, body });
  } catch (error) {
    return {
      ok: false,
      error: 'GITHUB_UPSTREAM_ERROR',
      message: String(error?.message || 'GitHub mutation transport failed.'),
      phase,
      github_path: path,
      attempts: 1,
      may_have_mutated: true,
    };
  }
  if (!response || response.status < 200 || response.status >= 300) {
    return transportFailure(response, phase, path, true);
  }
  return {
    ok: true,
    body: response.body,
    evidence: githubTransportEvidence(response, { phase, path, attempts: 1, mayHaveMutated: true }),
  };
}

async function readBranch(apiClient, normalized, options = {}, phase = 'inspect.branch') {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/branches/${encodePath(normalized.branch)}`;
  const result = await safeRead(apiClient, path, phase, options);
  if (!result.ok) return result;
  const head = String(result.body?.commit?.sha || '').toLowerCase();
  if (!SHA40.test(head)) {
    return { ok: false, error: 'GITHUB_INVALID_RESPONSE', message: 'GitHub returned a branch without a valid commit SHA.', phase, github_path: path };
  }
  return {
    ok: true,
    head,
    protected: Boolean(result.body?.protected),
    protection_summary: result.body?.protection || null,
    evidence: result.evidence,
  };
}

async function resolveChecks(apiClient, normalized, options = {}) {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/commits/${normalized.expected_head}/check-runs?filter=latest&per_page=100`;
  const result = await safeRead(apiClient, path, 'inspect.check_runs', options);
  if (!result.ok) return result;
  const runs = Array.isArray(result.body?.check_runs) ? result.body.check_runs : [];
  const resolved = [];
  for (const requested of normalized.required_checks) {
    const exact = runs.filter((run) => String(run?.name || '') === requested);
    if (!exact.length) {
      return {
        ok: false,
        error: 'GITHUB_REQUIRED_CHECK_UNKNOWN',
        message: `GitHub did not report an exact check run named ${requested} on expected_head.`,
        check: requested,
        expected_head: normalized.expected_head,
        observed_check_names: [...new Set(runs.map((run) => String(run?.name || '')).filter(Boolean))].sort(),
        phase: 'inspect.check_runs',
      };
    }
    const integrationIds = [...new Set(exact.map((run) => Number(run?.app?.id || 0)).filter((id) => Number.isInteger(id) && id > 0))];
    if (integrationIds.length !== 1) {
      return {
        ok: false,
        error: 'GITHUB_REQUIRED_CHECK_AMBIGUOUS',
        message: `Check ${requested} does not resolve to exactly one GitHub App integration.`,
        check: requested,
        integration_ids: integrationIds,
        phase: 'inspect.check_runs',
      };
    }
    const representative = exact.find((run) => Number(run?.app?.id || 0) === integrationIds[0]);
    resolved.push({
      context: requested,
      integration_id: integrationIds[0],
      integration_slug: representative?.app?.slug ? String(representative.app.slug) : null,
      check_run_id: Number(representative?.id || 0) || null,
    });
  }
  return { ok: true, checks: resolved, evidence: result.evidence };
}

function normalizeRequiredCheckEntry(entry) {
  const context = String(entry?.context || '').trim();
  if (!context) return null;
  const integrationId = Number(entry?.integration_id ?? entry?.app_id ?? 0);
  return {
    context,
    integration_id: Number.isInteger(integrationId) && integrationId > 0 ? integrationId : null,
  };
}

function keyForCheck(check) {
  return `${check.context}\u0000${check.integration_id ?? '*'}`;
}

function dedupeChecks(checks) {
  const map = new Map();
  for (const raw of checks) {
    const check = normalizeRequiredCheckEntry(raw);
    if (!check) continue;
    map.set(keyForCheck(check), check);
  }
  return [...map.values()].sort((a, b) => a.context.localeCompare(b.context) || Number(a.integration_id || 0) - Number(b.integration_id || 0));
}

function contexts(checks) {
  return [...new Set(checks.map((check) => check.context))].sort();
}

function requestedSatisfied(effective, requested) {
  return requested.every((wanted) => effective.some((seen) => seen.context === wanted.context
    && (seen.integration_id === null || seen.integration_id === wanted.integration_id)));
}

async function readRules(apiClient, normalized, options = {}, phase = 'inspect.rules') {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/rules/branches/${encodePath(normalized.branch)}?per_page=100`;
  const result = await safeRead(apiClient, path, phase, options);
  if (!result.ok) return result;
  const rules = Array.isArray(result.body) ? result.body : [];
  const requiredRules = rules.filter((rule) => rule?.type === 'required_status_checks');
  const requiredChecks = dedupeChecks(requiredRules.flatMap((rule) => rule?.parameters?.required_status_checks || []));
  return {
    ok: true,
    rules,
    required_rules: requiredRules,
    required_checks: requiredChecks,
    ruleset_ids: [...new Set(requiredRules.map((rule) => Number(rule?.ruleset_id || 0)).filter((id) => id > 0))].sort((a, b) => a - b),
    repository_ruleset_ids: [...new Set(requiredRules
      .filter((rule) => rule?.ruleset_source_type === 'Repository')
      .map((rule) => Number(rule?.ruleset_id || 0))
      .filter((id) => id > 0))].sort((a, b) => a - b),
    evidence: result.evidence,
  };
}

async function readProtection(apiClient, normalized, options = {}, phase = 'inspect.classic_protection') {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/branches/${encodePath(normalized.branch)}/protection`;
  const result = await safeRead(apiClient, path, phase, options, true);
  if (!result.ok) return result;
  if (!result.found) return { ok: true, enabled: false, required_checks: [], strict: false, raw: null, evidence: result.evidence };
  const status = result.body?.required_status_checks || null;
  const rawChecks = Array.isArray(status?.checks)
    ? status.checks
    : (Array.isArray(status?.contexts) ? status.contexts.map((context) => ({ context })) : []);
  return {
    ok: true,
    enabled: true,
    required_checks: dedupeChecks(rawChecks),
    strict: Boolean(status?.strict),
    raw: result.body,
    evidence: result.evidence,
  };
}

function protectionSnapshot(rules, protection) {
  return canonicalJson({
    effective_rules: rules.rules,
    classic_protection: protection.raw,
  });
}

function mechanismFor(rules, protection) {
  const hasRulesetChecks = rules.required_rules.length > 0;
  const hasClassic = protection.enabled;
  if (hasRulesetChecks && hasClassic) return 'mixed';
  if (hasRulesetChecks) return 'ruleset';
  if (hasClassic) return 'branch_protection';
  return 'none';
}

function effectiveChecks(rules, protection) {
  return dedupeChecks([...rules.required_checks, ...protection.required_checks]);
}

async function readRuleset(apiClient, normalized, id, options = {}, phase = 'inspect.ruleset') {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/rulesets/${id}?includes_parents=true`;
  const result = await safeRead(apiClient, path, phase, options);
  if (!result.ok) return result;
  return { ok: true, ruleset: result.body, path, evidence: result.evidence };
}

function mutableRulesetBody(ruleset, newRules) {
  return {
    name: ruleset.name,
    target: ruleset.target || 'branch',
    enforcement: ruleset.enforcement,
    bypass_actors: Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [],
    conditions: ruleset.conditions,
    rules: newRules,
  };
}

async function mutateRuleset(apiClient, normalized, beforeRules, resolvedChecks, options, evidence) {
  const repoIds = beforeRules.repository_ruleset_ids;
  const [owner, repo] = normalized.repo.split('/');

  if (repoIds.length === 1) {
    const initial = await readRuleset(apiClient, normalized, repoIds[0], options, 'inspect.ruleset_detail');
    if (!initial.ok) return initial;
    evidence.push(initial.evidence);
    const rules = Array.isArray(initial.ruleset?.rules) ? initial.ruleset.rules : [];
    const index = rules.findIndex((rule) => rule?.type === 'required_status_checks');
    if (index >= 0) {
      const currentRule = rules[index];
      const existing = dedupeChecks(currentRule?.parameters?.required_status_checks || []);
      const merged = dedupeChecks([...existing, ...resolvedChecks]);
      const nextRules = rules.map((rule, ruleIndex) => ruleIndex === index ? {
        ...rule,
        parameters: {
          ...rule.parameters,
          required_status_checks: merged.map((check) => ({ context: check.context, ...(check.integration_id ? { integration_id: check.integration_id } : {}) })),
        },
      } : rule);

      const latest = await readRuleset(apiClient, normalized, repoIds[0], options, 'precondition.ruleset_detail');
      if (!latest.ok) return latest;
      evidence.push(latest.evidence);
      if (canonicalJson(initial.ruleset) !== canonicalJson(latest.ruleset)) {
        return {
          ok: false,
          error: 'GITHUB_PROTECTION_CHANGED',
          message: 'The target ruleset changed between inspection and mutation.',
          ruleset_id: repoIds[0],
          phase: 'precondition.ruleset_detail',
        };
      }

      const mutation = await writeRequest(apiClient, initial.path, 'PUT', mutableRulesetBody(initial.ruleset, nextRules), 'mutate.ruleset');
      if (!mutation.ok) return mutation;
      evidence.push(mutation.evidence);
      return { ok: true, mechanism: 'ruleset', ruleset_id: repoIds[0], outcome: 'updated' };
    }
  }

  const createPath = `/repos/${encodePath(owner)}/${encodePath(repo)}/rulesets`;
  const body = {
    name: `Hatchable required checks: ${normalized.branch}`,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${normalized.branch}`], exclude: [] } },
    rules: [{
      type: 'required_status_checks',
      parameters: {
        do_not_enforce_on_create: false,
        strict_required_status_checks_policy: false,
        required_status_checks: resolvedChecks.map((check) => ({ context: check.context, integration_id: check.integration_id })),
      },
    }],
  };
  const mutation = await writeRequest(apiClient, createPath, 'POST', body, 'mutate.ruleset_create');
  if (!mutation.ok) return mutation;
  evidence.push(mutation.evidence);
  return {
    ok: true,
    mechanism: 'ruleset',
    ruleset_id: Number(mutation.body?.id || 0) || null,
    outcome: 'created',
  };
}

async function mutateClassic(apiClient, normalized, protection, resolvedChecks, evidence) {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/branches/${encodePath(normalized.branch)}/protection/required_status_checks`;
  const merged = dedupeChecks([...protection.required_checks, ...resolvedChecks]);
  const body = {
    strict: Boolean(protection.strict),
    checks: merged.map((check) => ({ context: check.context, ...(check.integration_id ? { app_id: check.integration_id } : { app_id: -1 }) })),
  };
  const mutation = await writeRequest(apiClient, path, 'PATCH', body, 'mutate.classic_protection');
  if (!mutation.ok) return mutation;
  evidence.push(mutation.evidence);
  return { ok: true, mechanism: 'branch_protection', ruleset_id: null, outcome: 'updated' };
}

function errorResult(error) {
  if (error instanceof GitHubRequiredChecksError) {
    return {
      ok: false,
      error: error.code,
      message: error.message,
      ...(error.details || {}),
      ...(error.httpStatus ? { status: error.httpStatus } : {}),
    };
  }
  return { ok: false, error: error?.code || 'INTERNAL_ERROR', message: String(error?.message || error || 'Unexpected required-check failure.') };
}

async function ensureNormalized(normalized, apiClient, options = {}) {
  const evidence = [];
  const branch = await readBranch(apiClient, normalized, options);
  if (!branch.ok) return branch;
  evidence.push(branch.evidence);
  if (branch.head !== normalized.expected_head) {
    return {
      ok: false,
      error: 'HEAD_MISMATCH',
      message: 'expected_head does not match the current branch head.',
      repo: normalized.repo,
      branch: normalized.branch,
      expected_head: normalized.expected_head,
      actual_head: branch.head,
      phase: 'inspect.branch',
    };
  }

  const resolved = await resolveChecks(apiClient, normalized, options);
  if (!resolved.ok) return resolved;
  evidence.push(resolved.evidence);

  const beforeRules = await readRules(apiClient, normalized, options);
  if (!beforeRules.ok) return beforeRules;
  evidence.push(beforeRules.evidence);
  const beforeProtection = await readProtection(apiClient, normalized, options);
  if (!beforeProtection.ok) return beforeProtection;
  evidence.push(beforeProtection.evidence);

  const beforeMechanism = mechanismFor(beforeRules, beforeProtection);
  const beforeEffective = effectiveChecks(beforeRules, beforeProtection);
  if (requestedSatisfied(beforeEffective, resolved.checks)) {
    return {
      ok: true,
      outcome: 'already_compliant',
      repo: normalized.repo,
      branch: normalized.branch,
      expected_head: normalized.expected_head,
      observed_head: branch.head,
      mechanism: beforeMechanism === 'none' ? 'ruleset' : beforeMechanism,
      changed: false,
      requested_checks: normalized.required_checks,
      resolved_checks: resolved.checks,
      effective_required_checks: contexts(beforeEffective),
      verified: true,
      ruleset_ids: beforeRules.ruleset_ids,
      github_evidence: evidence,
    };
  }

  if (beforeMechanism === 'mixed') {
    return {
      ok: false,
      error: 'GITHUB_PROTECTION_CONFLICT',
      message: 'Both ruleset required checks and classic branch protection are active; additive mutation is ambiguous.',
      mechanism: 'mixed',
      ruleset_ids: beforeRules.ruleset_ids,
      phase: 'inspect.protection',
    };
  }

  const preBranch = await readBranch(apiClient, normalized, options, 'precondition.branch');
  if (!preBranch.ok) return preBranch;
  evidence.push(preBranch.evidence);
  if (preBranch.head !== normalized.expected_head) {
    return {
      ok: false,
      error: 'HEAD_MISMATCH',
      message: 'The branch head moved before required-check mutation.',
      expected_head: normalized.expected_head,
      actual_head: preBranch.head,
      phase: 'precondition.branch',
    };
  }

  const preRules = await readRules(apiClient, normalized, options, 'precondition.rules');
  if (!preRules.ok) return preRules;
  evidence.push(preRules.evidence);
  const preProtection = await readProtection(apiClient, normalized, options, 'precondition.classic_protection');
  if (!preProtection.ok) return preProtection;
  evidence.push(preProtection.evidence);
  if (protectionSnapshot(beforeRules, beforeProtection) !== protectionSnapshot(preRules, preProtection)) {
    return {
      ok: false,
      error: 'GITHUB_PROTECTION_CHANGED',
      message: 'GitHub integration-protection state changed between inspection and mutation.',
      phase: 'precondition.protection',
    };
  }

  let mutation;
  if (beforeMechanism === 'branch_protection') {
    mutation = await mutateClassic(apiClient, normalized, beforeProtection, resolved.checks, evidence);
  } else {
    mutation = await mutateRuleset(apiClient, normalized, beforeRules, resolved.checks, options, evidence);
  }
  if (!mutation.ok) return mutation;

  const afterRules = await readRules(apiClient, normalized, options, 'verify.rules');
  if (!afterRules.ok) return {
    ...afterRules,
    error: 'GITHUB_REQUIRED_CHECKS_INDETERMINATE',
    message: 'GitHub mutation was accepted but authoritative required-check readback failed; retry the same intended configuration.',
    upstream_error: afterRules.error || null,
    may_have_mutated: true,
  };
  evidence.push(afterRules.evidence);
  const afterProtection = await readProtection(apiClient, normalized, options, 'verify.classic_protection');
  if (!afterProtection.ok) return {
    ...afterProtection,
    error: 'GITHUB_REQUIRED_CHECKS_INDETERMINATE',
    message: 'GitHub mutation was accepted but authoritative required-check readback failed; retry the same intended configuration.',
    upstream_error: afterProtection.error || null,
    may_have_mutated: true,
  };
  evidence.push(afterProtection.evidence);
  const afterBranch = await readBranch(apiClient, normalized, options, 'verify.branch');
  if (!afterBranch.ok) return {
    ...afterBranch,
    error: 'GITHUB_REQUIRED_CHECKS_INDETERMINATE',
    message: 'GitHub mutation was accepted but authoritative branch readback failed; retry the same intended configuration.',
    upstream_error: afterBranch.error || null,
    may_have_mutated: true,
  };
  evidence.push(afterBranch.evidence);

  const afterEffective = effectiveChecks(afterRules, afterProtection);
  const verified = requestedSatisfied(afterEffective, resolved.checks);
  if (!verified) {
    return {
      ok: false,
      error: 'GITHUB_REQUIRED_CHECKS_VERIFICATION_FAILED',
      message: 'GitHub accepted the mutation request, but an authoritative reread does not show all requested checks enforced.',
      repo: normalized.repo,
      branch: normalized.branch,
      mechanism: mutation.mechanism,
      ruleset_id: mutation.ruleset_id,
      requested_checks: normalized.required_checks,
      effective_required_checks: contexts(afterEffective),
      observed_head: afterBranch.head,
      phase: 'verify.protection',
      github_evidence: evidence,
    };
  }

  return {
    ok: true,
    outcome: mutation.outcome,
    repo: normalized.repo,
    branch: normalized.branch,
    expected_head: normalized.expected_head,
    observed_head: afterBranch.head,
    mechanism: mutation.mechanism,
    changed: true,
    requested_checks: normalized.required_checks,
    resolved_checks: resolved.checks,
    effective_required_checks: contexts(afterEffective),
    verified: true,
    ruleset_id: mutation.ruleset_id,
    ruleset_ids: afterRules.ruleset_ids,
    github_evidence: evidence,
  };
}

export async function ensureGithubRequiredChecks(input, options = {}) {
  try {
    const normalized = normalizeGithubRequiredChecksRequest(input);
    if (!options.apiClient) fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub API transport is required.', null, 500);
    return await ensureNormalized(normalized, options.apiClient, options);
  } catch (error) {
    return errorResult(error);
  }
}

export async function ensureGithubRequiredChecksWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubRequiredChecksRequest(input);
  } catch (error) {
    return errorResult(error);
  }

  try {
    return await withGitHubAppApiClient(normalized.repo, async (apiClient) => {
      return ensureNormalized(normalized, apiClient, options);
    }, { permissionProfile: 'required_checks' });
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
      return { ok: false, error: 'GITHUB_APP_SETUP_REQUIRED', message: 'Configure the GitHub App ID and private key in Hatchable Setup before using this command.' };
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
    const permissionMintFailure = Number(error?.status) === 401
      || Number(error?.status) === 403
      || (Number(error?.status) === 422 && /permission|not granted/i.test(message));
    if (permissionMintFailure) {
      return {
        ok: false,
        error: 'GITHUB_APP_PERMISSION_DENIED',
        message,
        upstream_status: Number(error.status),
        required_permissions: { administration: 'write', checks: 'read' },
        additional_permission: { administration: 'write' },
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