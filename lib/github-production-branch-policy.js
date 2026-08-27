import { canonicalJson } from 'lib/canonical-json.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
export const PRODUCTION_BRANCH_POLICY_RULESET_NAME = 'Portfolio production branch policy v1';

function failure(error, message, details = {}, mayHaveMutated = false) {
  return { ok: false, error, message, ...details, may_have_mutated: mayHaveMutated };
}

function desired(branch) {
  return {
    name: PRODUCTION_BRANCH_POLICY_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
    ],
  };
}

function projection(ruleset) {
  if (!ruleset) return null;
  return {
    name: String(ruleset.name || ''),
    target: String(ruleset.target || ''),
    enforcement: String(ruleset.enforcement || ''),
    bypass_actors: Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [],
    conditions: ruleset.conditions || null,
    rules: (Array.isArray(ruleset.rules) ? ruleset.rules : []).map(rule => ({ type: String(rule?.type || '') })).sort((a,b) => a.type.localeCompare(b.type)),
  };
}

export function normalizeGithubProductionBranchPolicyRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('request must be an object'), { code:'INVALID_REQUEST' });
  const allowed = new Set(['repo','expected_head']);
  const unknown = Object.keys(input).filter(key => !allowed.has(key)).sort();
  if (unknown.length) throw Object.assign(new Error('request contains unsupported fields'), { code:'INVALID_REQUEST', details:{ unsupported_fields:unknown } });
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  if (!REPO.test(repo)) throw Object.assign(new Error('repo must be owner/repo'), { code:'INVALID_REQUEST', details:{ field:'repo' } });
  const expectedHead = typeof input.expected_head === 'string' ? input.expected_head.trim().toLowerCase() : '';
  if (!SHA40.test(expectedHead)) throw Object.assign(new Error('expected_head must be a full Git commit SHA'), { code:'INVALID_REQUEST', details:{ field:'expected_head' } });
  return { repo, expected_head:expectedHead };
}

export async function reconcileGithubProductionBranchPolicy(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubProductionBranchPolicyRequest(input); }
  catch (error) { return failure(error.code || 'INVALID_REQUEST', error.message, error.details || {}, false); }
  const roles = options.branchRoles;
  if (!roles || roles.development_branch !== 'dev' || !roles.production_branch || roles.production_branch === 'dev') {
    return failure('GITHUB_PRODUCTION_BRANCH_POLICY_ROLES_REQUIRED', 'repository branch roles are required before production protection', {}, false);
  }
  const github = options.github;
  if (!github || ['getBranch','listRulesets','getRuleset','createRuleset','updateRuleset'].some(name => typeof github[name] !== 'function')) {
    return failure('GITHUB_PRODUCTION_BRANCH_POLICY_TRANSPORT_UNAVAILABLE', 'production branch policy GitHub adapter is incomplete', {}, false);
  }
  const branch = roles.production_branch;
  const observed = await github.getBranch(normalized.repo, branch);
  const observedHead = String(observed?.sha || '').toLowerCase();
  if (observedHead !== normalized.expected_head) return failure('HEAD_MISMATCH', 'production branch head changed before policy reconciliation', { branch, expected_head:normalized.expected_head, actual_head:observedHead || null }, false);

  const index = await github.listRulesets(normalized.repo);
  const matching = (Array.isArray(index) ? index : []).filter(item => String(item?.name || '') === PRODUCTION_BRANCH_POLICY_RULESET_NAME);
  if (matching.length > 1) return failure('GITHUB_PRODUCTION_BRANCH_POLICY_CONFLICT', 'more than one managed production ruleset exists', { ruleset_ids:matching.map(item => Number(item.id)).filter(Boolean) }, false);
  const intended = desired(branch);
  let existing = null;
  if (matching.length === 1) existing = await github.getRuleset(normalized.repo, matching[0].id);
  if (existing && canonicalJson(projection(existing)) === canonicalJson(projection(intended))) {
    return { ok:true, repo:normalized.repo, branch, expected_head:normalized.expected_head, observed_head:observedHead, changed:false, verified:true, ruleset_id:Number(existing.id || matching[0].id) || null, rules:intended.rules.map(rule => rule.type), may_have_mutated:false };
  }

  const pre = await github.getBranch(normalized.repo, branch);
  const preHead = String(pre?.sha || '').toLowerCase();
  if (preHead !== normalized.expected_head) return failure('HEAD_MISMATCH', 'production branch moved before policy mutation', { branch, expected_head:normalized.expected_head, actual_head:preHead || null }, false);
  let mutated;
  try {
    mutated = existing
      ? await github.updateRuleset(normalized.repo, Number(existing.id || matching[0].id), intended)
      : await github.createRuleset(normalized.repo, intended);
  } catch (error) {
    return failure('GITHUB_PRODUCTION_BRANCH_POLICY_INDETERMINATE', 'production ruleset mutation lost certainty', { upstream_error:String(error?.message || error) }, true);
  }
  const rulesetId = Number(mutated?.id || existing?.id || matching[0]?.id || 0) || null;
  const afterHead = String((await github.getBranch(normalized.repo, branch))?.sha || '').toLowerCase();
  const after = rulesetId ? await github.getRuleset(normalized.repo, rulesetId) : null;
  if (afterHead !== normalized.expected_head || canonicalJson(projection(after)) !== canonicalJson(projection(intended))) {
    return failure('GITHUB_PRODUCTION_BRANCH_POLICY_INDETERMINATE', 'authoritative readback does not prove intended production policy', { branch, expected_head:normalized.expected_head, actual_head:afterHead || null, ruleset_id:rulesetId }, true);
  }
  return { ok:true, repo:normalized.repo, branch, expected_head:normalized.expected_head, observed_head:afterHead, changed:true, verified:true, ruleset_id:rulesetId, rules:intended.rules.map(rule => rule.type), may_have_mutated:false };
}
