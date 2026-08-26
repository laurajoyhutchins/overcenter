import { commandFailure, commandSuccess } from 'lib/command-response.js';
import { githubAppPermissionProfile } from 'lib/github-app-auth.js';
import { safeRequestProjection, safeResultProjection } from 'lib/orchestration-journal.js';
import {
  ensureGithubMilestone,
  normalizeGithubMilestoneRequest,
} from 'lib/github-milestone.js';

const REPO = 'laurajoyhutchins/example';
const BASE = '/repos/laurajoyhutchins/example/milestones';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }
function response(status, body) { return { status, body, headers: {} }; }
function milestone(overrides = {}) {
  return {
    number: 7,
    title: 'Provider Contract',
    description: 'Old description',
    state: 'open',
    due_on: null,
    html_url: 'https://github.com/laurajoyhutchins/example/milestone/7',
    ...overrides,
  };
}
function queuedClient(steps) {
  const calls = [];
  return {
    calls,
    async call(name, request) {
      assert(name === 'github', `unexpected API name ${name}`);
      const step = steps.shift();
      assert(step, `unexpected call ${request.method || 'GET'} ${request.path}`);
      if (step.method) assert((request.method || 'GET') === step.method, `expected ${step.method}, got ${request.method || 'GET'}`);
      if (step.path) assert(request.path === step.path, `expected ${step.path}, got ${request.path}`);
      if (step.inspect) step.inspect(request);
      calls.push(request);
      const result = typeof step.result === 'function' ? step.result(request) : step.result;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export async function runGithubMilestoneTests() {
  const results = [];

  results.push(await run('request schema is exact and milestone title is stable identity', async () => {
    const normalized = normalizeGithubMilestoneRequest({
      repo: REPO,
      desired_state: { title: ' Provider Contract ', description: 'Contract layer', state: 'open', due_on: null },
      expected_state: { description: 'Old description', state: 'open' },
    });
    assert(normalized.desired_state.title === 'Provider Contract', 'title was not normalized');
    assert(normalized.desired_state.due_on === null, 'null due date changed');
    let rejected = false;
    try { normalizeGithubMilestoneRequest({ repo: REPO, desired_state: { title: 'Provider Contract', number: 7 } }); } catch { rejected = true; }
    assert(rejected, 'milestone number was accepted as caller-controlled identity');
  }));

  results.push(await run('milestone permission is command-owned and narrow', async () => {
    const permissions = githubAppPermissionProfile('milestone');
    assert(JSON.stringify(permissions) === JSON.stringify({ pull_requests: 'write', metadata: 'read' }), 'milestone permission profile is not narrow');
    assert(!('pull_requests' in githubAppPermissionProfile('changeset')), 'pull-request permission leaked into ordinary changesets');
  }));

  results.push(await run('already compliant milestone is a verified no-op', async () => {
    const current = milestone({ description: 'Contract layer' });
    const client = queuedClient([
      { method: 'GET', path: `${BASE}?state=all&per_page=100&page=1`, result: response(200, [current]) },
    ]);
    const result = await ensureGithubMilestone({ repo: REPO, desired_state: { title: 'Provider Contract', description: 'Contract layer', state: 'open', due_on: null } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'already_compliant', result.message || 'no-op failed');
    assert(result.changed === false && result.verified === true && result.milestone_number === 7, 'no-op evidence is incomplete');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'no-op mutated GitHub');
  }));

  results.push(await run('missing milestone is created once and verified by number', async () => {
    const created = milestone({ description: 'Contract layer' });
    const client = queuedClient([
      { method: 'GET', path: `${BASE}?state=all&per_page=100&page=1`, result: response(200, []) },
      { method: 'POST', path: BASE, inspect(request) { assert(JSON.stringify(request.body) === JSON.stringify({ title: 'Provider Contract', description: 'Contract layer', state: 'open', due_on: null }), 'create body changed'); }, result: response(201, created) },
      { method: 'GET', path: `${BASE}/7`, result: response(200, created) },
    ]);
    const result = await ensureGithubMilestone({ repo: REPO, desired_state: { title: 'Provider Contract', description: 'Contract layer', state: 'open', due_on: null } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'created', result.message || 'create failed');
    assert(result.milestone_number === 7 && result.verified === true, 'created milestone was not verified');
    assert(client.calls.filter((call) => call.method === 'POST').length === 1, 'milestone create was replayed');
  }));

  results.push(await run('existing milestone patches only changed declared fields and verifies', async () => {
    const before = milestone();
    const after = milestone({ description: 'New description' });
    const client = queuedClient([
      { method: 'GET', path: `${BASE}?state=all&per_page=100&page=1`, result: response(200, [before]) },
      { method: 'PATCH', path: `${BASE}/7`, inspect(request) { assert(JSON.stringify(request.body) === JSON.stringify({ description: 'New description' }), 'unexpected milestone patch'); }, result: response(200, after) },
      { method: 'GET', path: `${BASE}/7`, result: response(200, after) },
    ]);
    const result = await ensureGithubMilestone({ repo: REPO, desired_state: { title: 'Provider Contract', description: 'New description' }, expected_state: { description: 'Old description' } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'updated', result.message || 'update failed');
    assert(result.changed_fields.join(',') === 'description', 'changed field evidence is wrong');
  }));

  results.push(await run('stale expected milestone state fails closed before mutation', async () => {
    const client = queuedClient([{ method: 'GET', path: `${BASE}?state=all&per_page=100&page=1`, result: response(200, [milestone({ description: 'Someone changed it' })]) }]);
    const result = await ensureGithubMilestone({ repo: REPO, desired_state: { title: 'Provider Contract', description: 'New description' }, expected_state: { description: 'Old description' } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_MILESTONE_STATE_CHANGED', 'stale state was not rejected');
    assert(result.may_have_mutated === false, 'stale precondition claimed mutation');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'stale request mutated GitHub');
  }));

  results.push(await run('duplicate exact milestone titles fail closed as ambiguous', async () => {
    const client = queuedClient([{ method: 'GET', path: `${BASE}?state=all&per_page=100&page=1`, result: response(200, [milestone(), milestone({ number: 8 })]) }]);
    const result = await ensureGithubMilestone({ repo: REPO, desired_state: { title: 'Provider Contract' } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_MILESTONE_TITLE_AMBIGUOUS', 'duplicate title was not rejected');
    assert(result.may_have_mutated === false, 'ambiguous lookup claimed mutation');
  }));

  results.push(await run('ambiguous create reconciles by re-observing exact desired milestone', async () => {
    const current = milestone({ description: 'Contract layer' });
    const client = queuedClient([
      { method: 'GET', path: `${BASE}?state=all&per_page=100&page=1`, result: response(200, []) },
      { method: 'POST', path: BASE, result: new Error('connection reset after dispatch') },
      { method: 'GET', path: `${BASE}?state=all&per_page=100&page=1`, result: response(200, [current]) },
    ]);
    const result = await ensureGithubMilestone({ repo: REPO, desired_state: { title: 'Provider Contract', description: 'Contract layer' } }, { apiClient: client, sleep: async () => {}, maxAttempts: 1 });
    assert(result.ok === true && result.outcome === 'reconciled_after_indeterminate_write', result.message || 'ambiguous create did not reconcile');
    assert(client.calls.filter((call) => call.method === 'POST').length === 1, 'ambiguous create was replayed');
  }));

  results.push(await run('permission failure is typed and non-mutating', async () => {
    const client = queuedClient([{ method: 'GET', path: `${BASE}?state=all&per_page=100&page=1`, result: response(403, { message: 'Resource not accessible by integration' }) }]);
    const result = await ensureGithubMilestone({ repo: REPO, desired_state: { title: 'Provider Contract' } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_APP_PERMISSION_DENIED', 'permission failure was not typed');
    assert(result.required_permissions?.pull_requests === 'write', 'required pull-request permission is missing');
    assert(result.may_have_mutated === false, 'read failure claimed mutation');
  }));

  results.push(await run('command response and journal projections preserve milestone semantics without descriptions', async () => {
    const success = commandSuccess('github.milestone.ensure', { ok: true, outcome: 'already_compliant' });
    const stale = commandFailure('github.milestone.ensure', { ok: false, error: 'GITHUB_MILESTONE_STATE_CHANGED', message: 'state changed' });
    const indeterminate = commandFailure('github.milestone.ensure', { ok: false, error: 'GITHUB_MILESTONE_INDETERMINATE', message: 'reconcile', may_have_mutated: true });
    assert(success.command === 'github.milestone.ensure', 'canonical command is not registered');
    assert(stale.body.error_class === 'precondition' && stale.body.recommended_action === 'refresh_authority', 'stale milestone did not refresh authority');
    assert(indeterminate.body.retryable === true && indeterminate.body.recommended_action === 'reconcile_external_effect', 'indeterminate milestone did not reconcile external effect');
    const requestProjection = safeRequestProjection('github.milestone.ensure', { repo: REPO, desired_state: { title: 'Provider Contract', description: 'do not journal this' }, expected_state: { description: 'old secret-ish description' } });
    assert(requestProjection.title === 'Provider Contract', 'milestone title was lost');
    assert(requestProjection.desired_fields.join(',') === 'description,title', 'desired field projection changed');
    assert(!JSON.stringify(requestProjection).includes('do not journal this'), 'request projection leaked description');
    const resultProjection = safeResultProjection('github.milestone.ensure', { repo: REPO, title: 'Provider Contract', milestone_number: 7, outcome: 'updated', changed: true, verified: true, changed_fields: ['description'] });
    assert(resultProjection.milestone_number === 7 && resultProjection.changed_fields?.[0] === 'description', 'result projection lost milestone outcome');
  }));

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}
