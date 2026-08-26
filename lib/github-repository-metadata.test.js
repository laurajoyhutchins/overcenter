import { commandFailure, commandSuccess } from 'lib/command-response.js';
import { githubAppPermissionProfile } from 'lib/github-app-auth.js';
import { safeRequestProjection, safeResultProjection } from 'lib/orchestration-journal.js';
import {
  ensureGithubRepositoryMetadata,
  normalizeGithubRepositoryMetadataRequest,
} from 'lib/github-repository-metadata.js';

const REPO = 'laurajoyhutchins/example';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }
function response(status, body) { return { status, body, headers: {} }; }
function repository(overrides = {}) {
  return response(200, {
    full_name: REPO,
    description: 'Old description',
    homepage: null,
    topics: ['old-topic'],
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_discussions: false,
    ...overrides,
  });
}
function topics(names) { return response(200, { names }); }
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

export async function runGithubRepositoryMetadataTests() {
  const results = [];

  results.push(await run('request schema is exact and excludes identity or lifecycle mutation', async () => {
    const normalized = normalizeGithubRepositoryMetadataRequest({
      repo: REPO,
      desired_state: { description: 'New', topics: ['OverCenter', 'agent-runtime'], has_discussions: true },
      expected_state: { description: 'Old description', has_discussions: false },
    });
    assert(normalized.desired_state.topics.join(',') === 'agent-runtime,overcenter', 'topics were not canonicalized');
    for (const forbidden of ['visibility', 'archived', 'default_branch', 'new_name', 'transfer']) {
      let rejected = false;
      try { normalizeGithubRepositoryMetadataRequest({ repo: REPO, desired_state: { description: 'New', [forbidden]: true } }); } catch { rejected = true; }
      assert(rejected, `forbidden field ${forbidden} was accepted`);
    }
  }));

  results.push(await run('repository metadata permission is command-owned and does not leak into contents changes', async () => {
    const metadata = githubAppPermissionProfile('repository_metadata');
    const changeset = githubAppPermissionProfile('changeset');
    assert(JSON.stringify(metadata) === JSON.stringify({ administration: 'write', metadata: 'read' }), 'repository metadata permission profile is not narrow');
    assert(!('administration' in changeset), 'administration permission leaked into ordinary changesets');
  }));

  results.push(await run('already compliant state is a verified no-op', async () => {
    const client = queuedClient([
      { method: 'GET', result: repository({ description: 'New', topics: ['overcenter'], has_discussions: true }) },
      { method: 'GET', result: topics(['overcenter']) },
    ]);
    const result = await ensureGithubRepositoryMetadata({ repo: REPO, desired_state: { description: 'New', topics: ['overcenter'], has_discussions: true } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'already_compliant', result.message || 'no-op failed');
    assert(result.changed === false && result.verified === true, 'no-op was not verified');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'no-op mutated GitHub');
  }));

  results.push(await run('only changed declared fields are patched and topics use their dedicated endpoint', async () => {
    const repoPath = '/repos/laurajoyhutchins/example';
    const client = queuedClient([
      { method: 'GET', path: repoPath, result: repository() },
      { method: 'GET', path: `${repoPath}/topics`, result: topics(['old-topic']) },
      {
        method: 'PATCH', path: repoPath,
        inspect(request) {
          assert(JSON.stringify(request.body) === JSON.stringify({ description: 'New description', has_discussions: true }), `unexpected repository patch ${JSON.stringify(request.body)}`);
        },
        result: repository({ description: 'New description', has_discussions: true }),
      },
      {
        method: 'PUT', path: `${repoPath}/topics`,
        inspect(request) { assert(JSON.stringify(request.body) === JSON.stringify({ names: ['agent-runtime', 'overcenter'] }), 'topics mutation was not exact'); },
        result: topics(['agent-runtime', 'overcenter']),
      },
      { method: 'GET', path: repoPath, result: repository({ description: 'New description', has_discussions: true, topics: ['agent-runtime', 'overcenter'] }) },
      { method: 'GET', path: `${repoPath}/topics`, result: topics(['agent-runtime', 'overcenter']) },
    ]);
    const result = await ensureGithubRepositoryMetadata({
      repo: REPO,
      desired_state: { description: 'New description', has_discussions: true, topics: ['OverCenter', 'agent-runtime'] },
    }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'updated', result.message || 'mutation failed');
    assert(result.changed_fields.join(',') === 'description,has_discussions,topics', 'changed field evidence is wrong');
    assert(result.verified === true, 'post-write state was not verified');
  }));

  results.push(await run('stale expected state fails closed before mutation', async () => {
    const client = queuedClient([{ method: 'GET', result: repository({ description: 'Someone else changed it' }) }]);
    const result = await ensureGithubRepositoryMetadata({
      repo: REPO,
      desired_state: { description: 'New description' },
      expected_state: { description: 'Old description' },
    }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_METADATA_STATE_CHANGED', 'stale state was not rejected');
    assert(result.may_have_mutated === false, 'precondition failure claimed mutation');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'stale request mutated GitHub');
  }));

  results.push(await run('permission failure is typed and non-mutating', async () => {
    const client = queuedClient([{ method: 'GET', result: response(403, { message: 'Resource not accessible by integration' }) }]);
    const result = await ensureGithubRepositoryMetadata({ repo: REPO, desired_state: { description: 'New description' } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_APP_PERMISSION_DENIED', 'permission failure was not typed');
    assert(result.may_have_mutated === false, 'read permission failure claimed mutation');
  }));

  results.push(await run('ambiguous write reconciles authoritative desired state without replay', async () => {
    const client = queuedClient([
      { method: 'GET', result: repository() },
      { method: 'PATCH', result: new Error('connection reset after dispatch') },
      { method: 'GET', result: repository({ description: 'New description' }) },
    ]);
    const result = await ensureGithubRepositoryMetadata({ repo: REPO, desired_state: { description: 'New description' } }, { apiClient: client, sleep: async () => {}, maxAttempts: 1 });
    assert(result.ok === true && result.outcome === 'reconciled_after_indeterminate_write', result.message || 'ambiguous mutation did not reconcile');
    assert(client.calls.filter((call) => (call.method || 'GET') === 'PATCH').length === 1, 'ambiguous write was replayed');
  }));

  results.push(await run('partial multi-endpoint mutation remains indeterminate when desired state is not verified', async () => {
    const repoPath = '/repos/laurajoyhutchins/example';
    const client = queuedClient([
      { method: 'GET', path: repoPath, result: repository() },
      { method: 'GET', path: `${repoPath}/topics`, result: topics(['old-topic']) },
      { method: 'PATCH', path: repoPath, result: repository({ description: 'New description' }) },
      { method: 'PUT', path: `${repoPath}/topics`, result: response(403, { message: 'topics denied' }) },
      { method: 'GET', path: repoPath, result: repository({ description: 'New description' }) },
      { method: 'GET', path: `${repoPath}/topics`, result: topics(['old-topic']) },
    ]);
    const result = await ensureGithubRepositoryMetadata({ repo: REPO, desired_state: { description: 'New description', topics: ['overcenter'] } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_METADATA_INDETERMINATE', 'partial mutation was not indeterminate');
    assert(result.may_have_mutated === true, 'partial mutation lost mutation evidence');
  }));

  results.push(await run('command response and journal projections preserve semantics without storing metadata values', async () => {
    const success = commandSuccess('github.repository_metadata.ensure', { ok: true, outcome: 'already_compliant' });
    const stale = commandFailure('github.repository_metadata.ensure', { ok: false, error: 'GITHUB_REPOSITORY_METADATA_STATE_CHANGED', message: 'state changed' });
    const indeterminate = commandFailure('github.repository_metadata.ensure', { ok: false, error: 'GITHUB_REPOSITORY_METADATA_INDETERMINATE', message: 'reconcile', may_have_mutated: true });
    assert(success.command === 'github.repository_metadata.ensure', 'canonical command is not registered');
    assert(stale.body.error_class === 'precondition' && stale.body.recommended_action === 'refresh_authority', 'stale metadata did not refresh authority');
    assert(indeterminate.body.retryable === true && indeterminate.body.recommended_action === 'reconcile_external_effect', 'indeterminate metadata did not reconcile external effect');
    const requestProjection = safeRequestProjection('github.repository_metadata.ensure', { repo: REPO, desired_state: { description: 'secret-ish value', topics: ['one'] }, expected_state: { description: 'old value' } });
    assert(JSON.stringify(requestProjection) === JSON.stringify({ repo: REPO, desired_fields: ['description', 'topics'], expected_fields: ['description'] }), 'request projection leaked or lost fields');
    assert(!JSON.stringify(requestProjection).includes('secret-ish value'), 'journal projection stored metadata value');
    const resultProjection = safeResultProjection('github.repository_metadata.ensure', { repo: REPO, outcome: 'updated', changed: true, verified: true, changed_fields: ['description'] });
    assert(resultProjection.changed_fields?.[0] === 'description' && resultProjection.verified === true, 'result projection lost metadata outcome');
  }));

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}