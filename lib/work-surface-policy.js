export const WORK_SURFACE_DISPOSITIONS = Object.freeze([
  'KEEP_EXECUTABLE',
  'BLOCKED_EXTERNAL',
  'WAITING_HUMAN',
  'DERIVED_STATE',
  'HISTORICAL_REFERENCE',
  'SUPERSEDED',
  'DUPLICATE',
  'DISPOSED_REPOSITORY',
  'NO_EXECUTABLE_ACTION',
]);

const DISPOSITION_SET = new Set(WORK_SURFACE_DISPOSITIONS);
const TERMINAL = new Set([
  'DERIVED_STATE', 'HISTORICAL_REFERENCE', 'SUPERSEDED', 'DUPLICATE',
  'DISPOSED_REPOSITORY', 'NO_EXECUTABLE_ACTION',
]);
const FRONTIER_LIMITS = Object.freeze({
  'U.S. Jurisdiction Coverage': 3,
});
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

export function classifyWorkSurfaceProjection(input = {}) {
  const requested = text(input.disposition) || 'KEEP_EXECUTABLE';
  const outcome = text(input.outcome);
  const nextAction = text(input.next_action);
  const actor = text(input.actor).toLowerCase();
  const changesAuthority = input.changes_authority_or_produces_evidence === true;
  const promotionCondition = text(input.promotion_condition);

  if (!DISPOSITION_SET.has(requested)) {
    return { disposition: 'NO_EXECUTABLE_ACTION', visible: false, linear_state: null, reason: 'INVALID_DISPOSITION' };
  }
  if (TERMINAL.has(requested)) {
    return { disposition: requested, visible: false, linear_state: null, reason: requested };
  }
  if (!outcome || !nextAction || !changesAuthority) {
    return { disposition: 'NO_EXECUTABLE_ACTION', visible: false, linear_state: null, reason: 'EXECUTABLE_ACTION_PREDICATE_FAILED' };
  }
  if (actor === 'deterministic') {
    return { disposition: 'DERIVED_STATE', visible: false, linear_state: null, reason: 'DETERMINISTIC_BOOKKEEPING' };
  }
  if (actor === 'none' || !actor) {
    return { disposition: 'NO_EXECUTABLE_ACTION', visible: false, linear_state: null, reason: 'NO_ACTOR' };
  }
  if (requested === 'WAITING_HUMAN') {
    if (actor !== 'human' || !promotionCondition) {
      return { disposition: 'NO_EXECUTABLE_ACTION', visible: false, linear_state: null, reason: 'INVALID_HUMAN_WAIT' };
    }
    return { disposition: 'WAITING_HUMAN', visible: true, linear_state: 'Backlog', reason: 'WAITING_HUMAN' };
  }
  if (requested === 'BLOCKED_EXTERNAL') {
    if (actor !== 'external' || !promotionCondition) {
      return { disposition: 'NO_EXECUTABLE_ACTION', visible: false, linear_state: null, reason: 'INVALID_EXTERNAL_BLOCK' };
    }
    return { disposition: 'BLOCKED_EXTERNAL', visible: true, linear_state: 'Backlog', reason: 'BLOCKED_EXTERNAL' };
  }
  if (requested === 'KEEP_EXECUTABLE' && actor !== 'worker') {
    return actor === 'human'
      ? { disposition: 'WAITING_HUMAN', visible: true, linear_state: 'Backlog', reason: 'ACTOR_REQUIRES_HUMAN' }
      : actor === 'external'
        ? { disposition: 'BLOCKED_EXTERNAL', visible: Boolean(promotionCondition), linear_state: promotionCondition ? 'Backlog' : null, reason: promotionCondition ? 'ACTOR_REQUIRES_EXTERNAL' : 'MISSING_PROMOTION_CONDITION' }
        : { disposition: 'NO_EXECUTABLE_ACTION', visible: false, linear_state: null, reason: 'UNAVAILABLE_ACTOR' };
  }
  return { disposition: 'KEEP_EXECUTABLE', visible: true, linear_state: 'Todo', reason: 'EXECUTABLE_ACTION' };
}

export function canonicalExecutableSourceKey({ repo, issue_number, unit_key = null, canonical_key = null } = {}) {
  const canonical = text(canonical_key).toLowerCase();
  if (canonical) {
    if (!KEY_RE.test(canonical)) throw new Error('canonical_key must be a stable token of at most 256 characters');
    return `canonical:${canonical}`;
  }
  const normalizedRepo = text(repo).toLowerCase();
  const issue = Number(issue_number);
  const unit = text(unit_key).toLowerCase();
  if (unit && !KEY_RE.test(unit)) throw new Error('unit_key must be a stable token of at most 256 characters');
  return `github:${normalizedRepo}#issue:${issue}${unit ? `#unit:${unit}` : ''}`;
}

export function frontierLimitForProject(projectName, explicitLimit = null) {
  if (explicitLimit !== null && explicitLimit !== undefined) {
    const limit = Number(explicitLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('frontier_limit must be an integer from 1 through 25');
    return limit;
  }
  return FRONTIER_LIMITS[text(projectName)] || null;
}

export function terminalStateForDisposition(disposition, { authoritative_complete = false } = {}) {
  if (disposition === 'DUPLICATE') return 'Duplicate';
  if (disposition === 'DERIVED_STATE') return authoritative_complete ? 'Done' : 'Canceled';
  if (disposition === 'HISTORICAL_REFERENCE') return authoritative_complete ? 'Done' : 'Canceled';
  if (['SUPERSEDED','DISPOSED_REPOSITORY','NO_EXECUTABLE_ACTION'].includes(disposition)) return authoritative_complete ? 'Done' : 'Canceled';
  return null;
}

export const workSurfacePolicyConfig = Object.freeze({ frontier_limits: FRONTIER_LIMITS });