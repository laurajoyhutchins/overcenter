import { canonicalJson } from 'lib/canonical-json.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';
import {
  BRANCH_POLICY_VERSION,
  MANAGED_BRANCH_POLICY_RULESET_NAMES,
  REPOSITORY_MERGE_POLICY,
  desiredDefaultBranchRules,
  managedBranchPolicyRulesetName,
} from 'lib/branch-policy-v1.js';

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

export function normalizeGithubBranchPolicyRequest(input) {
  const body = object(input, 'request');
  exactFields(body, new Set(['repo', 'expected_head', 'required_checks']), 'request');
  return {
    repo: validateRepo(body.repo),
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

function repositoryMergeProjection(body) {
  return Object.fromEntries(Object.keys(REPOSITORY_MERGE_POLICY).map((key) => [key, body?.[key]]));
}

function repositoryMergeCompliant(body) {
  return Object.entries(REPOSITORY_MERGE_POLICY).every(([key, value]) => body?.[key] === value);
}

async function readRepository(apiClient, normalized, options = {}, phase = 'inspect.repository') {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}`;
  const result = await safeRead(apiClient, path, phase, options);
  if (!result.ok) return result;
  const defaultBranch = String(result.body?.default_branch || '').trim();
  if (!defaultBranch) {
    return { ok: false, error: 'GITHUB_INVALID_RESPONSE', message: 'GitHub returned a repository without a default branch.', phase, github_path: path };
  }
  return {
    ok: true,
    default_branch: defaultBranch,
    private: Boolean(result.body?.private),
    visibility: result.body?.visibility ? String(result.body.visibility) : null,
    merge_settings: repositoryMergeProjection(result.body),
    merge_compliant: repositoryMergeCompliant(result.body),
    raw: result.body,
    path,
    evidence: result.evidence,
  };
}

async function readRulesetIndex(apiClient, normalized, options = {}, phase = 'inspect.rulesets') {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/rulesets?includes_parents=true&per_page=100`;
  const result = await safeRead(apiClient, path, phase, options);
  if (!result.ok) {
    if (Number(result.upstream_status || 0) === 403 && /upgrade|private|feature/i.test(String(result.message || ''))) {
      return {
        ok: false,
        error: 'GITHUB_BRANCH_POLICY_UNAVAILABLE_BY_PLAN',
        message: String(result.message || 'GitHub rulesets are unavailable for this repository under the current plan.'),
        phase,
        github_path: path,
        upstream_status: 403,
        may_have_mutated: false,
      };
    }
    return result;
  }
  return { ok: true, rulesets: Array.isArray(result.body) ? result.body : [], path, evidence: result.evidence };
}

function isManagedRulesetSummary(ruleset) {
  const name = String(ruleset?.name || '');
  return MANAGED_BRANCH_POLICY_RULESET_NAMES.includes(name) || name.startsWith('Hatchable required checks: ');
}

async function resolveChecks(apiClient, normalized, options = {}, existingEffectiveChecks = []) {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/commits/${normalized.expected_head}/check-runs?filter=latest&per_page=100`;
  const result = await safeRead(apiClient, path, 'inspect.check_runs', options);
  if (!result.ok) return result;
  const runs = Array.isArray(result.body?.check_runs) ? result.body.check_runs : [];
  const effective = dedupeChecks(existingEffectiveChecks);
  const resolved = [];
  for (const requested of normalized.required_checks) {
    const exact = runs.filter((run) => String(run?.name || '') === requested);
    if (!exact.length) {
      const preserved = effective.filter((check) => check.context === requested);
      if (preserved.length === 1) {
        resolved.push({
          context: requested,
          integration_id: preserved[0].integration_id,
          integration_slug: null,
          check_run_id: null,
          resolution_source: 'effective_policy',
        });
        continue;
      }
      if (preserved.length > 1) {
        return {
          ok: false,
          error: 'GITHUB_REQUIRED_CHECK_AMBIGUOUS',
          message: `Existing effective policy contains more than one identity for required context ${requested}.`,
          check: requested,
          integration_ids: preserved.map((check) => check.integration_id),
          phase: 'inspect.effective_policy',
        };
      }
      return {
        ok: false,
        error: 'GITHUB_REQUIRED_CHECK_UNKNOWN',
        message: `GitHub did not report an exact check run named ${requested} on expected_head and the context is not already enforced by effective policy.`,
        check: requested,
        expected_head: normalized.expected_head,
        observed_check_names: [...new Set(runs.map((run) => String(run?.name || '')).filter(Boolean))].sort(),
        existing_effective_contexts: contexts(effective),
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
      resolution_source: 'exact_head_check_run',
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

function pullRequestRuleProjection(rule) {
  const parameters = rule?.parameters || {};
  return {
    type: 'pull_request',
    parameters: {
      allowed_merge_methods: [...(parameters.allowed_merge_methods || [])].sort(),
      dismiss_stale_reviews_on_push: Boolean(parameters.dismiss_stale_reviews_on_push),
      require_code_owner_review: Boolean(parameters.require_code_owner_review),
      require_last_push_approval: Boolean(parameters.require_last_push_approval),
      required_approving_review_count: Number(parameters.required_approving_review_count || 0),
      required_review_thread_resolution: Boolean(parameters.required_review_thread_resolution),
      required_reviewers: Array.isArray(parameters.required_reviewers) ? parameters.required_reviewers : [],
    },
  };
}

function ruleProjection(rule) {
  const type = String(rule?.type || '');
  if (type === 'pull_request') return pullRequestRuleProjection(rule);
  if (type === 'required_status_checks') {
    return {
      type,
      parameters: {
        do_not_enforce_on_create: Boolean(rule?.parameters?.do_not_enforce_on_create),
        strict_required_status_checks_policy: Boolean(rule?.parameters?.strict_required_status_checks_policy),
        required_status_checks: dedupeChecks(rule?.parameters?.required_status_checks || []),
      },
    };
  }
  return { type };
}

function rulesProjection(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map(ruleProjection)
    .sort((a, b) => a.type.localeCompare(b.type));
}

function managedRulesetProjection(ruleset) {
  if (!ruleset) return null;
  return {
    name: String(ruleset.name || ''),
    target: String(ruleset.target || ''),
    enforcement: String(ruleset.enforcement || ''),
    bypass_actors: Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [],
    conditions: ruleset.conditions || null,
    rules: rulesProjection(ruleset.rules),
  };
}

function desiredRulesetBody(resolvedChecks) {
  return {
    name: managedBranchPolicyRulesetName(),
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: desiredDefaultBranchRules(resolvedChecks),
  };
}

function sameManagedPolicy(ruleset, desired) {
  return canonicalJson(managedRulesetProjection(ruleset)) === canonicalJson({
    ...desired,
    rules: rulesProjection(desired.rules),
  });
}

function policySnapshot(inspection) {
  return canonicalJson({
    default_branch: inspection.repo.default_branch,
    merge_settings: inspection.repo.merge_settings,
    head: inspection.branch.head,
    ruleset_index: inspection.index.rulesets.map((ruleset) => ({
      id: Number(ruleset?.id || 0) || null,
      name: String(ruleset?.name || ''),
      enforcement: String(ruleset?.enforcement || ''),
      source_type: String(ruleset?.source_type || ''),
      source: String(ruleset?.source || ''),
    })),
    managed_ruleset: managedRulesetProjection(inspection.managed?.ruleset || null),
    effective_rules: inspection.effective.rules,
    classic_protection: inspection.protection.raw,
    resolved_checks: inspection.resolved.checks,
  });
}

async function inspectBranchPolicy(apiClient, normalized, options = {}, phasePrefix = 'inspect') {
  const evidence = [];
  const repo = await readRepository(apiClient, normalized, options, `${phasePrefix}.repository`);
  if (!repo.ok) return repo;
  evidence.push(repo.evidence);

  const index = await readRulesetIndex(apiClient, normalized, options, `${phasePrefix}.rulesets`);
  if (!index.ok) return index;
  evidence.push(index.evidence);

  const target = { ...normalized, branch: repo.default_branch };
  const branch = await readBranch(apiClient, target, options, `${phasePrefix}.branch`);
  if (!branch.ok) return branch;
  evidence.push(branch.evidence);
  if (branch.head !== normalized.expected_head) {
    return {
      ok: false,
      error: 'HEAD_MISMATCH',
      message: 'expected_head does not match the current default-branch head.',
      repo: normalized.repo,
      branch: repo.default_branch,
      expected_head: normalized.expected_head,
      actual_head: branch.head,
      phase: `${phasePrefix}.branch`,
    };
  }

  const effective = await readRules(apiClient, target, options, `${phasePrefix}.rules`);
  if (!effective.ok) return effective;
  evidence.push(effective.evidence);
  const resolved = await resolveChecks(apiClient, target, options, effective.required_checks);
  if (!resolved.ok) return resolved;
  evidence.push(resolved.evidence);
  const protection = await readProtection(apiClient, target, options, `${phasePrefix}.classic_protection`);
  if (!protection.ok) return protection;
  evidence.push(protection.evidence);

  const managedSummaries = index.rulesets.filter((ruleset) => isManagedRulesetSummary(ruleset)
    && String(ruleset?.source_type || 'Repository') === 'Repository');
  if (managedSummaries.length > 1) {
    return {
      ok: false,
      error: 'GITHUB_PROTECTION_CONFLICT',
      message: 'More than one repository ruleset is recognized as Portfolio branch-policy authority.',
      ruleset_ids: managedSummaries.map((ruleset) => Number(ruleset.id)).filter(Boolean),
      phase: `${phasePrefix}.rulesets`,
    };
  }

  let managed = null;
  if (managedSummaries.length === 1) {
    managed = await readRuleset(apiClient, target, managedSummaries[0].id, options, `${phasePrefix}.managed_ruleset`);
    if (!managed.ok) return managed;
    evidence.push(managed.evidence);
  }
  const managedId = Number(managed?.ruleset?.id || 0) || null;
  const effectiveIds = [...new Set(effective.rules.map((rule) => Number(rule?.ruleset_id || 0)).filter((id) => id > 0))];
  const unmanagedEffectiveIds = effectiveIds.filter((id) => id !== managedId);
  if (unmanagedEffectiveIds.length) {
    return {
      ok: false,
      error: 'GITHUB_PROTECTION_CONFLICT',
      message: 'An unowned ruleset currently contributes effective default-branch policy; branch-policy reconciliation will not overwrite or layer over it.',
      ruleset_ids: unmanagedEffectiveIds,
      phase: `${phasePrefix}.rules`,
    };
  }
  if (protection.enabled) {
    return {
      ok: false,
      error: 'GITHUB_PROTECTION_CONFLICT',
      message: 'Classic branch protection is active; branch-policy reconciliation will not silently replace it.',
      mechanism: 'branch_protection',
      phase: `${phasePrefix}.classic_protection`,
    };
  }

  return {
    ok: true,
    repo,
    index,
    branch,
    target,
    resolved,
    effective,
    protection,
    managed,
    evidence,
  };
}

async function reconcileBranchPolicyNormalized(normalized, apiClient, options = {}) {
  const initial = await inspectBranchPolicy(apiClient, normalized, options, 'inspect');
  if (!initial.ok) return initial;
  const desired = desiredRulesetBody(initial.resolved.checks);
  const initialRulesetCompliant = Boolean(initial.managed?.ruleset) && sameManagedPolicy(initial.managed.ruleset, desired);
  if (initial.repo.merge_compliant && initialRulesetCompliant) {
    return {
      ok: true,
      outcome: 'already_compliant',
      policy_version: BRANCH_POLICY_VERSION,
      repo: normalized.repo,
      default_branch: initial.repo.default_branch,
      expected_head: normalized.expected_head,
      observed_head: initial.branch.head,
      changed: false,
      required_checks: normalized.required_checks,
      resolved_checks: initial.resolved.checks,
      ruleset_id: Number(initial.managed.ruleset.id || 0) || null,
      merge_settings: initial.repo.merge_settings,
      verified: true,
      github_evidence: initial.evidence,
    };
  }

  const pre = await inspectBranchPolicy(apiClient, normalized, options, 'precondition');
  if (!pre.ok) return pre;
  if (policySnapshot(initial) !== policySnapshot(pre)) {
    return {
      ok: false,
      error: 'GITHUB_PROTECTION_CHANGED',
      message: 'GitHub branch-policy state changed between inspection and mutation.',
      repo: normalized.repo,
      branch: initial.repo.default_branch,
      phase: 'precondition.policy',
    };
  }

  const evidence = [...initial.evidence, ...pre.evidence];
  const changedSurfaces = [];
  if (!pre.repo.merge_compliant) {
    const mutation = await writeRequest(apiClient, pre.repo.path, 'PATCH', REPOSITORY_MERGE_POLICY, 'mutate.repository_settings');
    if (!mutation.ok) return mutation;
    evidence.push(mutation.evidence);
    changedSurfaces.push('repository_merge_settings');
  }

  const rulesetCompliant = Boolean(pre.managed?.ruleset) && sameManagedPolicy(pre.managed.ruleset, desired);
  let rulesetId = Number(pre.managed?.ruleset?.id || 0) || null;
  if (!rulesetCompliant) {
    const [owner, repoName] = normalized.repo.split('/');
    const path = rulesetId
      ? `/repos/${encodePath(owner)}/${encodePath(repoName)}/rulesets/${rulesetId}`
      : `/repos/${encodePath(owner)}/${encodePath(repoName)}/rulesets`;
    const method = rulesetId ? 'PUT' : 'POST';
    const mutation = await writeRequest(apiClient, path, method, desired, rulesetId ? 'mutate.ruleset' : 'mutate.ruleset_create');
    if (!mutation.ok) {
      if (changedSurfaces.length) {
        return {
          ok: false,
          error: 'GITHUB_BRANCH_POLICY_INDETERMINATE',
          message: 'Repository merge settings were changed, but ruleset reconciliation did not complete. Retry the same intended policy.',
          upstream_error: mutation.error || null,
          phase: mutation.phase || 'mutate.ruleset',
          may_have_mutated: true,
          changed_surfaces: changedSurfaces,
          github_evidence: evidence,
        };
      }
      return mutation;
    }
    evidence.push(mutation.evidence);
    rulesetId = Number(mutation.body?.id || rulesetId || 0) || rulesetId;
    changedSurfaces.push('default_branch_ruleset');
  }

  const after = await inspectBranchPolicy(apiClient, normalized, options, 'verify');
  if (!after.ok) {
    return {
      ...after,
      error: 'GITHUB_BRANCH_POLICY_INDETERMINATE',
      message: 'GitHub accepted branch-policy mutation, but authoritative readback did not complete. Retry the same intended policy.',
      upstream_error: after.error || null,
      may_have_mutated: true,
      changed_surfaces: changedSurfaces,
      github_evidence: evidence,
    };
  }
  evidence.push(...after.evidence);
  const verifiedDesired = desiredRulesetBody(after.resolved.checks);
  const verified = after.repo.merge_compliant
    && Boolean(after.managed?.ruleset)
    && sameManagedPolicy(after.managed.ruleset, verifiedDesired);
  if (!verified) {
    return {
      ok: false,
      error: 'GITHUB_BRANCH_POLICY_VERIFICATION_FAILED',
      message: 'GitHub accepted branch-policy mutation, but authoritative readback does not match branch-policy-v1.',
      repo: normalized.repo,
      default_branch: after.repo.default_branch,
      observed_head: after.branch.head,
      changed_surfaces: changedSurfaces,
      may_have_mutated: true,
      phase: 'verify.policy',
      github_evidence: evidence,
    };
  }

  return {
    ok: true,
    outcome: pre.managed?.ruleset ? 'updated' : 'created',
    policy_version: BRANCH_POLICY_VERSION,
    repo: normalized.repo,
    default_branch: after.repo.default_branch,
    expected_head: normalized.expected_head,
    observed_head: after.branch.head,
    changed: changedSurfaces.length > 0,
    changed_surfaces: changedSurfaces,
    required_checks: normalized.required_checks,
    resolved_checks: after.resolved.checks,
    ruleset_id: Number(after.managed?.ruleset?.id || rulesetId || 0) || null,
    merge_settings: after.repo.merge_settings,
    verified: true,
    github_evidence: evidence,
  };
}

export async function reconcileGithubBranchPolicy(input, options = {}) {
  try {
    const normalized = normalizeGithubBranchPolicyRequest(input);
    if (!options.apiClient) fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub API transport is required.', null, 500);
    return await reconcileBranchPolicyNormalized(normalized, options.apiClient, options);
  } catch (error) {
    return errorResult(error);
  }
}

export async function reconcileGithubBranchPolicyWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubBranchPolicyRequest(input);
  } catch (error) {
    return errorResult(error);
  }
  try {
    return await withGitHubAppApiClient(normalized.repo, async (apiClient) => {
      return reconcileBranchPolicyNormalized(normalized, apiClient, options);
    }, { permissionProfile: 'branch_policy' });
  } catch (error) {
    const message = String(error?.message || 'GitHub App authentication failed.');
    const setupRequired = /config\/get 412|declared as required but not set/i.test(message);
    if (setupRequired) return { ok: false, error: 'GITHUB_APP_SETUP_REQUIRED', message: 'Configure the GitHub App ID and private key in Hatchable Setup before using this command.' };
    if (Number(error?.status) === 404) return { ok: false, error: 'GITHUB_APP_INSTALLATION_NOT_FOUND', message: 'The GitHub App is not installed for this repository.', upstream_status: 404 };
    if (Number(error?.status) === 401 || Number(error?.status) === 403) {
      return {
        ok: false,
        error: 'GITHUB_APP_PERMISSION_DENIED',
        message,
        upstream_status: Number(error.status),
        required_permissions: { administration: 'write', checks: 'read' },
      };
    }
    return { ok: false, error: error?.code || 'GITHUB_APP_AUTH_ERROR', message, ...(error?.status ? { upstream_status: Number(error.status) } : {}) };
  }
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