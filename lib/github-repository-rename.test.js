import { commandFailure, commandSuccess } from 'lib/command-response.js';
import { safeRequestProjection, safeResultProjection } from 'lib/orchestration-journal.js';
import {
  normalizeGithubRepositoryRenameRequest,
  renameGithubRepository,
  renameGithubRepositoryWithGitHubApp,
} from 'lib/github-repository-rename.js';

const OLD_REPO = 'laurajoyhutchins/old-name';
const NEW_REPO = 'laurajoyhutchins/new-name';
const REPOSITORY_ID = 123456789;

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }
function response(status, body, headers = {}) { return { status, body, headers }; }
function repository(fullName, id = REPOSITORY_ID) { return response(200, { id, full_name: fullName, name: fullName.split('/')[1] }); }
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

function request(overrides = {}) {
  return { repo: OLD_REPO, new_name: 'new-name', expected_repository_id: REPOSITORY_ID, ...overrides };
}

export async function runGithubRepositoryRenameTests() {
  const results = [];

  results.push(await run('request schema is exact and derives the target coordinate', async () => {
    const normalized = normalizeGithubRepositoryRenameRequest(request());
    assert(normalized.repo === OLD_REPO, 'old coordinate changed');
    assert(normalized.new_repo === NEW_REPO, 'target coordinate was not derived');
    assert(normalized.expected_repository_id === REPOSITORY_ID, 'repository id was not normalized');
    for (const forbidden of ['transfer', 'visibility', 'archived', 'default_branch', 'owner']) {
      let rejected = false;
      try { normalizeGithubRepositoryRenameRequest({ ...request(), [forbidden]: true }); } catch { rejected = true; }
      assert(rejected, `forbidden field ${forbidden} was accepted`);
    }
  }));

  results.push(await run('immutable repository identity mismatch fails before mutation', async () => {
    const path = '/repos/laurajoyhutchins/old-name';
    const client = queuedClient([{ method: 'GET', path, result: repository(OLD_REPO, REPOSITORY_ID + 1) }]);
    const result = await renameGithubRepository(request(), { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_IDENTITY_CHANGED', result.message || 'identity mismatch was not rejected');
    assert(result.may_have_mutated === false, 'identity mismatch claimed mutation');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'identity mismatch mutated GitHub');
  }));

  results.push(await run('already-renamed authoritative read is a verified no-op', async () => {
    const client = queuedClient([{ method: 'GET', path: '/repos/laurajoyhutchins/old-name', result: repository(NEW_REPO) }]);
    const result = await renameGithubRepository(request(), { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'already_renamed', result.message || 'already-renamed state did not converge');
    assert(result.changed === false && result.verified === true, 'already-renamed result was not a verified no-op');
    assert(result.repository_id === REPOSITORY_ID && result.new_repo === NEW_REPO, 'already-renamed receipt lost identity');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'already-renamed replay wrote GitHub');
  }));

  results.push(await run('rename patches only the repository name and verifies the immutable id at the new coordinate', async () => {
    const oldPath = '/repos/laurajoyhutchins/old-name';
    const newPath = '/repos/laurajoyhutchins/new-name';
    const client = queuedClient([
      { method: 'GET', path: oldPath, result: repository(OLD_REPO) },
      {
        method: 'PATCH', path: oldPath,
        inspect(call) { assert(JSON.stringify(call.body) === JSON.stringify({ name: 'new-name' }), `unexpected rename body ${JSON.stringify(call.body)}`); },
        result: repository(NEW_REPO),
      },
      { method: 'GET', path: newPath, result: repository(NEW_REPO) },
    ]);
    const result = await renameGithubRepository(request(), { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'renamed', result.message || 'rename failed');
    assert(result.changed === true && result.verified === true, 'rename was not verified');
    assert(result.repository_id === REPOSITORY_ID && result.repo === OLD_REPO && result.new_repo === NEW_REPO, 'rename receipt lost coordinates or identity');
  }));

  results.push(await run('definitive GitHub rejection is typed and non-mutating', async () => {
    const path = '/repos/laurajoyhutchins/old-name';
    const client = queuedClient([
      { method: 'GET', path, result: repository(OLD_REPO) },
      { method: 'PATCH', path, result: response(422, { message: 'name already exists on this account' }) },
    ]);
    const result = await renameGithubRepository(request(), { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_RENAME_REJECTED', 'GitHub rejection was not typed');
    assert(result.may_have_mutated === false, 'definitive rejection claimed mutation');
    assert(result.upstream_status === 422, 'rejection lost upstream status');
  }));

  results.push(await run('ambiguous write reconciles the target identity without replaying the mutation', async () => {
    const oldPath = '/repos/laurajoyhutchins/old-name';
    const newPath = '/repos/laurajoyhutchins/new-name';
    const client = queuedClient([
      { method: 'GET', path: oldPath, result: repository(OLD_REPO) },
      { method: 'PATCH', path: oldPath, result: new Error('connection reset after dispatch') },
      { method: 'GET', path: newPath, result: repository(NEW_REPO) },
    ]);
    const result = await renameGithubRepository(request(), { apiClient: client, sleep: async () => {}, maxAttempts: 1 });
    assert(result.ok === true && result.outcome === 'reconciled_after_indeterminate_write', result.message || 'ambiguous rename did not reconcile');
    assert(result.verified === true && result.changed === true, 'reconciled rename did not verify');
    assert(client.calls.filter((call) => (call.method || 'GET') === 'PATCH').length === 1, 'ambiguous rename was replayed');
  }));

  results.push(await run('unverified post-write identity remains indeterminate', async () => {
    const oldPath = '/repos/laurajoyhutchins/old-name';
    const newPath = '/repos/laurajoyhutchins/new-name';
    const client = queuedClient([
      { method: 'GET', path: oldPath, result: repository(OLD_REPO) },
      { method: 'PATCH', path: oldPath, result: repository(NEW_REPO) },
      { method: 'GET', path: newPath, result: repository(NEW_REPO, REPOSITORY_ID + 1) },
    ]);
    const result = await renameGithubRepository(request(), { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_RENAME_INDETERMINATE', 'verification mismatch was not indeterminate');
    assert(result.may_have_mutated === true, 'verification mismatch lost mutation uncertainty');
  }));

  results.push(await run('GitHub App retry can recover against the new coordinate after the old token scope stops resolving', async () => {
    const authRepos = [];
    const client = queuedClient([{ method: 'GET', path: '/repos/laurajoyhutchins/old-name', result: repository(NEW_REPO) }]);
    const result = await renameGithubRepositoryWithGitHubApp(request(), {
      withGitHubAppApiClient: async (repo, callback, options) => {
        authRepos.push(repo);
        assert(options.permissionProfile === 'repository_metadata', 'rename requested a broader permission profile');
        if (repo === OLD_REPO) throw Object.assign(new Error('old coordinate no longer token-scopable'), { status: 404 });
        return callback(client);
      },
      sleep: async () => {},
    });
    assert(result.ok === true && result.outcome === 'already_renamed', result.message || 'new-coordinate auth recovery failed');
    assert(authRepos.join(',') === `${OLD_REPO},${NEW_REPO}`, `unexpected auth retry order ${authRepos.join(',')}`);
  }));

  results.push(await run('command response and journal projections preserve rename recovery semantics', async () => {
    const success = commandSuccess('github.repository.rename', { ok: true, outcome: 'renamed' });
    const stale = commandFailure('github.repository.rename', { ok: false, error: 'GITHUB_REPOSITORY_IDENTITY_CHANGED', message: 'identity changed' });
    const indeterminate = commandFailure('github.repository.rename', { ok: false, error: 'GITHUB_REPOSITORY_RENAME_INDETERMINATE', message: 'reconcile', may_have_mutated: true });
    assert(success.command === 'github.repository.rename', 'canonical rename command is not registered');
    assert(stale.body.error_class === 'precondition' && stale.body.recommended_action === 'refresh_authority', 'identity mismatch did not refresh authority');
    assert(indeterminate.body.retryable === true && indeterminate.body.recommended_action === 'reconcile_external_effect', 'indeterminate rename did not reconcile external effect');
    const requestProjection = safeRequestProjection('github.repository.rename', request());
    assert(JSON.stringify(requestProjection) === JSON.stringify({ repo: OLD_REPO, new_name: 'new-name', expected_repository_id: REPOSITORY_ID }), 'request projection lost rename identity');
    const resultProjection = safeResultProjection('github.repository.rename', { repo: OLD_REPO, new_repo: NEW_REPO, repository_id: REPOSITORY_ID, outcome: 'renamed', changed: true, verified: true });
    assert(resultProjection.repository_id === REPOSITORY_ID && resultProjection.new_repo === NEW_REPO && resultProjection.verified === true, 'result projection lost rename verification');
  }));

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}
