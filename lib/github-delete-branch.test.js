import {
  deleteGithubBranch,
  normalizeGithubDeleteBranchRequest,
} from 'lib/github-delete-branch.js';

const EXPECTED = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

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

function okPreflight({ branch = 'feature/test', head = EXPECTED, defaultBranch = 'main', exists = true } = {}) {
  return {
    status: 200,
    headers: {},
    body: {
      data: {
        repository: {
          id: 'R_repo',
          defaultBranchRef: { name: defaultBranch },
          ref: exists ? { name: branch, target: { oid: head } } : null,
        },
      },
    },
  };
}

function okMutation() {
  return { status: 200, headers: {}, body: { data: { updateRefs: { clientMutationId: null } } } };
}

function client(responses, calls) {
  return {
    async graphql(query, variables) {
      calls.push({ query, variables });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export async function runGithubDeleteBranchTests() {
  const results = [];

  results.push(await run('normalization requires exact fenced input', async () => {
    const normalized = normalizeGithubDeleteBranchRequest({
      repo: 'owner/repo', branch: 'feature/test', expected_head: EXPECTED.toUpperCase(),
    });
    assert(normalized.expected_head === EXPECTED, 'expected_head was not normalized');
    let rejected = false;
    try { normalizeGithubDeleteBranchRequest({ repo: 'owner/repo', branch: 'feature/test' }); } catch { rejected = true; }
    assert(rejected, 'missing expected_head was accepted');
  }));

  results.push(await run('default branch is rejected before mutation', async () => {
    const calls = [];
    const result = await deleteGithubBranch(
      { repo: 'owner/repo', branch: 'main', expected_head: EXPECTED },
      { apiClient: client([okPreflight({ branch: 'main', defaultBranch: 'main' })], calls), sleep: async () => {} },
    );
    assert(result.ok === false && result.error === 'GITHUB_REF_REJECTED', 'default branch was not rejected');
    assert(calls.length === 1, 'mutation ran for default branch');
  }));

  results.push(await run('stale expected head is rejected before mutation', async () => {
    const calls = [];
    const result = await deleteGithubBranch(
      { repo: 'owner/repo', branch: 'feature/test', expected_head: EXPECTED },
      { apiClient: client([okPreflight({ head: OTHER })], calls), sleep: async () => {} },
    );
    assert(result.ok === false && result.error === 'HEAD_MISMATCH', 'stale expected head was not rejected');
    assert(result.actual_head === OTHER, 'actual head evidence missing');
    assert(calls.length === 1, 'mutation ran after head mismatch');
  }));

  results.push(await run('absent branch is idempotent success', async () => {
    const calls = [];
    const result = await deleteGithubBranch(
      { repo: 'owner/repo', branch: 'feature/test', expected_head: EXPECTED },
      { apiClient: client([okPreflight({ exists: false })], calls), sleep: async () => {} },
    );
    assert(result.ok === true && result.outcome === 'already_absent', 'absent branch was not idempotent success');
    assert(calls.length === 1, 'mutation ran for absent branch');
  }));

  results.push(await run('delete uses atomic beforeOid to zero-OID compare-and-swap', async () => {
    const calls = [];
    const result = await deleteGithubBranch(
      { repo: 'owner/repo', branch: 'feature/test', expected_head: EXPECTED },
      { apiClient: client([okPreflight(), okMutation()], calls), sleep: async () => {} },
    );
    assert(result.ok === true && result.outcome === 'deleted', 'successful delete did not return deleted');
    assert(result.atomic_compare_and_swap === true, 'atomic CAS evidence missing');
    assert(calls.length === 2, 'unexpected GraphQL call count');
    const update = calls[1].variables.input.refUpdates[0];
    assert(update.name === 'refs/heads/feature/test', 'mutation escaped branch namespace');
    assert(update.beforeOid === EXPECTED, 'mutation did not fence on expected head');
    assert(update.afterOid === '0'.repeat(40), 'mutation did not use delete zero OID');
    assert(update.force === false, 'mutation unexpectedly allowed force');
  }));

  results.push(await run('atomic rejection reconciles moved head as HEAD_MISMATCH', async () => {
    const calls = [];
    const rejected = {
      status: 200,
      headers: {},
      body: { data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', message: 'Ref update rejected' }] },
    };
    const result = await deleteGithubBranch(
      { repo: 'owner/repo', branch: 'feature/test', expected_head: EXPECTED },
      { apiClient: client([okPreflight(), rejected, okPreflight({ head: OTHER })], calls), sleep: async () => {} },
    );
    assert(result.ok === false && result.error === 'HEAD_MISMATCH', 'race was not reconciled as head mismatch');
    assert(result.actual_head === OTHER, 'race result omitted current head');
  }));

  results.push(await run('policy rejection remains expected ref rejection', async () => {
    const calls = [];
    const rejected = {
      status: 200,
      headers: {},
      body: { data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', message: 'Repository rule violation' }] },
    };
    const result = await deleteGithubBranch(
      { repo: 'owner/repo', branch: 'feature/test', expected_head: EXPECTED },
      { apiClient: client([okPreflight(), rejected, okPreflight()], calls), sleep: async () => {} },
    );
    assert(result.ok === false && result.error === 'GITHUB_REF_REJECTED', 'policy rejection was not preserved');
    assert(result.reason === 'github_policy_or_ref_rule', 'policy rejection reason missing');
  }));

  results.push(await run('mutation transport loss is explicitly indeterminate and retry-safe', async () => {
    const calls = [];
    const result = await deleteGithubBranch(
      { repo: 'owner/repo', branch: 'feature/test', expected_head: EXPECTED },
      { apiClient: client([okPreflight(), new Error('connection reset')], calls), sleep: async () => {} },
    );
    assert(result.ok === false && result.error === 'BRANCH_DELETE_INDETERMINATE', 'transport loss was not marked indeterminate');
    assert(result.may_have_mutated === true, 'indeterminate mutation omitted mutation uncertainty');
  }));

  return {
    ok: results.every((result) => result.ok),
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    tests: results,
  };
}