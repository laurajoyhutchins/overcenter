import { commandFailure, commandSuccess } from 'lib/command-response.js';
import {
  ensureGithubAutoMerge,
  normalizeGithubAutoMergeRequest,
} from 'lib/github-auto-merge.js';

const REPO = 'laurajoyhutchins/example';

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

async function run(name, fn) {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: String(error?.message || error) };
  }
}

function response(status, body) {
  return { status, body, headers: {} };
}

function repository(allowAutoMerge) {
  return response(200, {
    full_name: REPO,
    allow_auto_merge: allowAutoMerge,
  });
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
      if (step.inspect) step.inspect(request);
      calls.push(request);
      const result = typeof step.result === 'function' ? step.result(request) : step.result;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export async function runGithubAutoMergeTests() {
  const results = [];

  results.push(await run('request is exact and boolean-valued', async () => {
    const normalized = normalizeGithubAutoMergeRequest({ repo: REPO, enabled: true, expected_state: false });
    assert(normalized.repo === REPO, 'repository changed');
    assert(normalized.enabled === true, 'enabled changed');
    assert(normalized.expected_state === false, 'expected state changed');

    for (const invalid of [
      { repo: REPO, enabled: 'true' },
      { repo: REPO, enabled: true, expected_state: 'false' },
      { repo: REPO, enabled: true, toggle: true },
    ]) {
      let rejected = false;
      try { normalizeGithubAutoMergeRequest(invalid); } catch { rejected = true; }
      assert(rejected, `invalid request was accepted: ${JSON.stringify(invalid)}`);
    }
  }));

  results.push(await run('already compliant is an idempotent verified success', async () => {
    const client = queuedClient([{ method: 'GET', result: repository(true) }]);
    const result = await ensureGithubAutoMerge({ repo: REPO, enabled: true }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true, result.message);
    assert(result.outcome === 'already_compliant', 'wrong outcome');
    assert(result.changed === false, 'no-op reported mutation');
    assert(result.before?.enabled === true && result.after?.enabled === true, 'before/after evidence missing');
    assert(result.verified === true, 'no-op was not verified from authoritative read');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'idempotent path mutated GitHub');
  }));

  results.push(await run('ensure writes the desired value and verifies authoritative state', async () => {
    const client = queuedClient([
      { method: 'GET', result: repository(false) },
      {
        method: 'PATCH',
        inspect(request) {
          assert(request.body?.allow_auto_merge === true, 'mutation did not set exact desired state');
          assert(Object.keys(request.body).length === 1, 'mutation changed unrelated repository settings');
        },
        result: repository(true),
      },
      { method: 'GET', result: repository(true) },
    ]);
    const result = await ensureGithubAutoMerge({ repo: REPO, enabled: true }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true, result.message);
    assert(result.outcome === 'updated' && result.changed === true, 'mutation was not reported');
    assert(result.before?.enabled === false && result.after?.enabled === true, 'state transition evidence missing');
    assert(result.verified === true, 'post-write state was not verified');
  }));

  results.push(await run('expected state mismatch fails closed before mutation', async () => {
    const client = queuedClient([{ method: 'GET', result: repository(true) }]);
    const result = await ensureGithubAutoMerge(
      { repo: REPO, enabled: false, expected_state: false },
      { apiClient: client, sleep: async () => {} },
    );
    assert(result.ok === false && result.error === 'GITHUB_AUTO_MERGE_STATE_CHANGED', 'stale expected state was not rejected');
    assert(result.observed_state === true, 'observed state evidence missing');
    assert(result.may_have_mutated === false, 'precondition rejection claimed mutation');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'stale request mutated GitHub');
  }));

  results.push(await run('uncertain mutation reconciles authoritative desired state instead of replaying', async () => {
    const client = queuedClient([
      { method: 'GET', result: repository(false) },
      { method: 'PATCH', result: new Error('connection reset after dispatch') },
      { method: 'GET', result: repository(true) },
    ]);
    const result = await ensureGithubAutoMerge({ repo: REPO, enabled: true }, { apiClient: client, sleep: async () => {}, maxAttempts: 1 });
    assert(result.ok === true, result.message);
    assert(result.outcome === 'reconciled_after_indeterminate_write', `wrong recovery outcome ${result.outcome}`);
    assert(result.changed === true && result.verified === true, 'reconciled mutation not verified');
    assert(client.calls.filter((call) => (call.method || 'GET') === 'PATCH').length === 1, 'uncertain write was replayed');
  }));

  results.push(await run('failed post-write verification remains explicitly indeterminate', async () => {
    const client = queuedClient([
      { method: 'GET', result: repository(false) },
      { method: 'PATCH', result: repository(true) },
      { method: 'GET', result: repository(false) },
    ]);
    const result = await ensureGithubAutoMerge({ repo: REPO, enabled: true }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_AUTO_MERGE_INDETERMINATE', 'verification failure became success');
    assert(result.may_have_mutated === true, 'post-write ambiguity lost mutation evidence');
  }));

  results.push(await run('command-response semantics classify stale state and indeterminate mutation mechanically', async () => {
    const success = commandSuccess('github.auto_merge.ensure', { ok: true, outcome: 'already_compliant' });
    const stale = commandFailure('github.auto_merge.ensure', {
      ok: false,
      error: 'GITHUB_AUTO_MERGE_STATE_CHANGED',
      message: 'repository state changed',
    });
    const indeterminate = commandFailure('github.auto_merge.ensure', {
      ok: false,
      error: 'GITHUB_AUTO_MERGE_INDETERMINATE',
      message: 'mutation requires reconciliation',
      may_have_mutated: true,
    });
    assert(success.command === 'github.auto_merge.ensure', 'canonical command is not registered');
    assert(stale.body.error_class === 'precondition' && stale.body.rejection === true, 'stale state is not a deterministic precondition rejection');
    assert(stale.body.recommended_action === 'refresh_authority', 'stale state does not refresh authority');
    assert(indeterminate.body.retryable === true && indeterminate.body.may_have_mutated === true, 'indeterminate mutation semantics changed');
    assert(indeterminate.body.recommended_action === 'reconcile_external_effect', 'indeterminate mutation does not reconcile external state');
  }));

  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    tests: results,
  };
}
