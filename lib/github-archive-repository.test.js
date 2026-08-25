import {
  archiveGithubRepository,
  archiveGithubRepositoryWithGitHubApp,
  normalizeGithubArchiveRepositoryRequest,
} from 'lib/github-archive-repository.js';
import { commandFailure, commandSuccess, classifyCommandError } from 'lib/command-response.js';
import { githubAppCapabilityCatalog, githubAppPermissionProfile } from 'lib/github-app-auth.js';
import { safeRequestProjection, safeResultProjection } from 'lib/orchestration-journal.js';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function response(status, body) {
  return { status, body };
}

function fakeClient(sequence) {
  const calls = [];
  return {
    calls,
    async call(provider, request) {
      calls.push({ provider, request: JSON.parse(JSON.stringify(request)) });
      if (!sequence.length) throw new Error('unexpected GitHub call');
      const next = sequence.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(request) : next;
    },
  };
}

export async function runGithubArchiveRepositoryTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok: true }); }
    catch (error) { tests.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('archive repository is a canonical command with mechanical recovery semantics', async () => {
    const body = commandSuccess('github.archive_repository', { ok: true, outcome: 'fixture' }, { now: () => '2026-08-25T04:00:00.000Z' });
    assert(body.command === 'github.archive_repository', 'archive command is not registered canonically');
    const mismatch = classifyCommandError('GITHUB_REPOSITORY_ID_MISMATCH');
    assert(mismatch.error_class === 'precondition' && mismatch.rejection === true && mismatch.retryable === false, 'identity mismatch classification is unsafe');
    const mismatchResponse = commandFailure('github.archive_repository', { ok: false, error: 'GITHUB_REPOSITORY_ID_MISMATCH', message: 'identity moved' });
    assert(mismatchResponse.body.recommended_action === 'refresh_authority', 'identity mismatch did not mechanically refresh authority');
    const indeterminate = commandFailure('github.archive_repository', { ok: false, error: 'REPOSITORY_ARCHIVE_INDETERMINATE', message: 'write uncertain', may_have_mutated: true });
    assert(indeterminate.body.retryable === true && indeterminate.body.recommended_action === 'reconcile_external_effect', 'indeterminate archive did not mechanically reconcile external state');
  });

  await test('archive permission is narrow and command-owned', async () => {
    const profile = githubAppPermissionProfile('archive_repository');
    assert(JSON.stringify(profile) === JSON.stringify({ administration: 'write' }), 'archive permission is not administration write only');
    const capability = githubAppCapabilityCatalog().archive_repository;
    assert(capability?.fallback?.class === 'fail_closed' && capability?.fallback?.mechanism === null, 'archive capability gained a fallback mutation path');
  });

  await test('archive command journal preserves authorization and confirmation evidence', async () => {
    const request = safeRequestProjection('github.archive_repository', {
      repo: 'owner/repo', expected_repository_id: 123, expected_archived: false, ignored_secret: 'nope',
    });
    assert(JSON.stringify(request) === JSON.stringify({ repo: 'owner/repo', expected_repository_id: 123, expected_archived: false }), 'archive request projection is incomplete or overbroad');
    const result = safeResultProjection('github.archive_repository', {
      repo: 'owner/repo', repository_id: 123, expected_repository_id: 123, archived: true, confirmed: true, outcome: 'archived', unrelated: 'nope',
    });
    assert(result.repo === 'owner/repo' && result.repository_id === 123 && result.archived === true && result.confirmed === true && result.outcome === 'archived', 'archive result projection lost confirmation evidence');
    assert(!('unrelated' in result), 'archive result projection leaked unrelated fields');
  });

  await test('request requires exact repository identity and expected unarchived state', async () => {
    const normalized = normalizeGithubArchiveRepositoryRequest({
      repo: 'owner/repo',
      expected_repository_id: 123,
      expected_archived: false,
    });
    assert(normalized.repo === 'owner/repo', 'repository changed');
    assert(normalized.expected_repository_id === 123, 'repository id changed');
    assert(normalized.expected_archived === false, 'expected archive state changed');

    let failure = null;
    try {
      normalizeGithubArchiveRepositoryRequest({
        repo: 'owner/repo',
        expected_repository_id: 123,
        expected_archived: false,
        force: true,
      });
    } catch (error) { failure = error; }
    assert(failure?.code === 'INVALID_REQUEST', 'unknown fields were accepted');
  });

  await test('repository id mismatch fails closed before mutation', async () => {
    const client = fakeClient([
      response(200, { id: 999, full_name: 'owner/repo', archived: false }),
    ]);
    const result = await archiveGithubRepository({
      repo: 'owner/repo', expected_repository_id: 123, expected_archived: false,
    }, client);
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_ID_MISMATCH', 'identity mismatch did not fail closed');
    assert(client.calls.length === 1 && client.calls[0].request.method !== 'PATCH', 'archive mutation occurred after identity mismatch');
  });

  await test('already archived repository is an idempotent success after identity verification', async () => {
    const client = fakeClient([
      response(200, { id: 123, full_name: 'owner/repo', archived: true }),
    ]);
    const result = await archiveGithubRepository({
      repo: 'owner/repo', expected_repository_id: 123, expected_archived: false,
    }, client);
    assert(result.ok === true && result.outcome === 'already_archived', 'already archived was not idempotent');
    assert(result.archived === true && result.repository_id === 123, 'idempotent result omitted authoritative state');
    assert(client.calls.length === 1, 'already archived path attempted mutation');
  });

  await test('successful archive is reread and confirmed authoritatively', async () => {
    const client = fakeClient([
      response(200, { id: 123, full_name: 'owner/repo', archived: false }),
      response(200, { id: 123, full_name: 'owner/repo', archived: true }),
      response(200, { id: 123, full_name: 'owner/repo', archived: true }),
    ]);
    const result = await archiveGithubRepository({
      repo: 'owner/repo', expected_repository_id: 123, expected_archived: false,
    }, client);
    assert(result.ok === true && result.outcome === 'archived', 'archive did not succeed');
    assert(result.archived === true && result.confirmed === true, 'archive was not confirmed');
    const patch = client.calls.find((call) => call.request.method === 'PATCH');
    assert(Boolean(patch), 'archive PATCH was not sent');
    assert(JSON.stringify(patch.request.body) === JSON.stringify({ archived: true }), 'archive PATCH carried extra repository mutation');
  });

  await test('post-dispatch transport failure reconciles to success when GitHub confirms archived', async () => {
    const transport = Object.assign(new Error('connection reset'), { code: 'TRANSPORT_UNAVAILABLE' });
    const client = fakeClient([
      response(200, { id: 123, full_name: 'owner/repo', archived: false }),
      transport,
      response(200, { id: 123, full_name: 'owner/repo', archived: true }),
    ]);
    const result = await archiveGithubRepository({
      repo: 'owner/repo', expected_repository_id: 123, expected_archived: false,
    }, client);
    assert(result.ok === true && result.outcome === 'archived_after_reconcile', 'confirmed indeterminate mutation did not reconcile to success');
    assert(result.confirmed === true, 'reconciled archive was not confirmed');
  });

  await test('unreconciled post-dispatch failure is retryable and reports possible mutation', async () => {
    const transport = Object.assign(new Error('connection reset'), { code: 'TRANSPORT_UNAVAILABLE' });
    const client = fakeClient([
      response(200, { id: 123, full_name: 'owner/repo', archived: false }),
      transport,
      response(200, { id: 123, full_name: 'owner/repo', archived: false }),
    ]);
    const result = await archiveGithubRepository({
      repo: 'owner/repo', expected_repository_id: 123, expected_archived: false,
    }, client);
    assert(result.ok === false && result.error === 'REPOSITORY_ARCHIVE_INDETERMINATE', 'indeterminate archive used the wrong failure code');
    assert(result.may_have_mutated === true, 'indeterminate archive did not report possible mutation');
  });

  await test('permission denial is reported without fallback mutation path', async () => {
    const client = fakeClient([
      response(403, { message: 'Resource not accessible by integration' }),
    ]);
    const result = await archiveGithubRepository({
      repo: 'owner/repo', expected_repository_id: 123, expected_archived: false,
    }, client);
    assert(result.ok === false && result.error === 'GITHUB_PERMISSION_DENIED', 'permission denial was not classified');
    assert(result.may_have_mutated === false, 'preflight permission denial claimed mutation risk');
  });

  await test('GitHub App token permission denial stays a typed permission failure', async () => {
    const result = await archiveGithubRepositoryWithGitHubApp({
      repo: 'owner/repo', expected_repository_id: 123, expected_archived: false,
    }, {
      withGitHubAppApiClient: async (_repo, _callback, options) => {
        assert(options.permissionProfile === 'archive_repository', 'archive wrapper used the wrong permission profile');
        throw Object.assign(new Error('permissions not permitted'), {
          status: 422,
          phase: 'auth.token_mint',
          mayHaveMutated: false,
        });
      },
    });
    assert(result.ok === false && result.error === 'GITHUB_APP_PERMISSION_DENIED', 'GitHub App permission denial lost its stable error code');
    assert(result.phase === 'auth.token_mint' && result.may_have_mutated === false, 'GitHub App permission denial lost transport evidence');
  });

  return {
    ok: tests.every((item) => item.ok),
    passed: tests.filter((item) => item.ok).length,
    failed: tests.filter((item) => !item.ok).length,
    tests,
  };
}
