import { ensureGithubRequiredChecks } from 'lib/github-required-checks.js';

const HEAD = '7755b471ce6e012864c96f35af01c73911c53ddc';
const REPO = 'laurajoyhutchins/STE-Lint';
const REQUEST = {
  repo: REPO,
  branch: 'main',
  expected_head: HEAD,
  required_checks: ['authority-ingest', 'rust'],
};

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

function branchResponse(head = HEAD) {
  return response(200, { name: 'main', commit: { sha: head }, protected: false, protection: { enabled: false } });
}

function checkRunsResponse() {
  return response(200, {
    total_count: 2,
    check_runs: [
      { id: 101, name: 'authority-ingest', app: { id: 15368, slug: 'github-actions' } },
      { id: 102, name: 'rust', app: { id: 15368, slug: 'github-actions' } },
    ],
  });
}

function requiredRule(checks, rulesetId = 42) {
  return {
    type: 'required_status_checks',
    ruleset_id: rulesetId,
    ruleset_source_type: 'Repository',
    ruleset_source: REPO,
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: checks.map((check) => typeof check === 'string'
        ? { context: check, integration_id: 15368 }
        : check),
    },
  };
}

function rulesResponse(checks = []) {
  return response(200, checks.length ? [requiredRule(checks)] : []);
}

function protectionAbsent() {
  return response(404, { message: 'Branch not protected' });
}

function rulesetDetail(checks = ['existing-check']) {
  return {
    id: 42,
    name: 'Existing repository rules',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [requiredRule(checks).parameters ? {
      type: 'required_status_checks',
      parameters: requiredRule(checks).parameters,
    } : null].filter(Boolean),
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
      if (step.path) assert(request.path === step.path, `expected path ${step.path}, got ${request.path}`);
      if (step.inspect) step.inspect(request);
      calls.push(request);
      const result = typeof step.result === 'function' ? step.result(request) : step.result;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function commonInitial(rules = rulesResponse([])) {
  return [
    { method: 'GET', result: branchResponse() },
    { method: 'GET', result: checkRunsResponse() },
    { method: 'GET', result: rules },
    { method: 'GET', result: protectionAbsent() },
  ];
}

function commonPrecondition(rules = rulesResponse([])) {
  return [
    { method: 'GET', result: branchResponse() },
    { method: 'GET', result: rules },
    { method: 'GET', result: protectionAbsent() },
  ];
}

function commonVerification(rules) {
  return [
    { method: 'GET', result: rules },
    { method: 'GET', result: protectionAbsent() },
    { method: 'GET', result: branchResponse() },
  ];
}

export async function runGithubRequiredChecksTests() {
  const results = [];

  results.push(await run('already compliant is idempotent and does not mutate', async () => {
    const client = queuedClient(commonInitial(rulesResponse(['authority-ingest', 'rust'])));
    const result = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true, result.message);
    assert(result.changed === false, 'already-compliant command reported a mutation');
    assert(result.outcome === 'already_compliant', 'wrong idempotent outcome');
    assert(result.verified === true, 'already-compliant state was not verified');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'idempotent path mutated GitHub');
  }));

  results.push(await run('no required checks creates an active branch ruleset and verifies', async () => {
    const steps = [
      ...commonInitial(),
      ...commonPrecondition(),
      {
        method: 'POST',
        inspect(request) {
          assert(request.path.endsWith('/rulesets'), 'did not create a ruleset');
          assert(request.body.enforcement === 'active', 'ruleset not active');
          assert(request.body.conditions.ref_name.include[0] === 'refs/heads/main', 'ruleset not branch-specific');
          const checks = request.body.rules[0].parameters.required_status_checks;
          assert(checks.length === 2, 'wrong number of checks in create payload');
          assert(checks.every((check) => check.integration_id === 15368), 'check integration identity missing');
        },
        result: response(201, { id: 88 }),
      },
      ...commonVerification(rulesResponse(['authority-ingest', 'rust'])),
    ];
    const client = queuedClient(steps);
    const result = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true, result.message);
    assert(result.changed === true && result.mechanism === 'ruleset', 'ruleset mutation not reported');
    assert(result.ruleset_id === 88, 'created ruleset id missing');
    assert(result.verified === true, 'post-mutation verification missing');
  }));

  results.push(await run('existing unrelated requirement is preserved during additive update', async () => {
    const beforeRules = rulesResponse(['existing-check']);
    const detail = rulesetDetail(['existing-check']);
    const steps = [
      ...commonInitial(beforeRules),
      ...commonPrecondition(beforeRules),
      { method: 'GET', result: response(200, detail) },
      { method: 'GET', result: response(200, detail) },
      {
        method: 'PUT',
        inspect(request) {
          const statusRule = request.body.rules.find((rule) => rule.type === 'required_status_checks');
          const names = statusRule.parameters.required_status_checks.map((check) => check.context).sort();
          assert(JSON.stringify(names) === JSON.stringify(['authority-ingest', 'existing-check', 'rust']), `unrelated check was not preserved: ${names}`);
          assert(request.body.name === detail.name, 'ruleset name changed');
          assert(request.body.enforcement === detail.enforcement, 'ruleset enforcement changed');
        },
        result: response(200, { ...detail }),
      },
      ...commonVerification(rulesResponse(['existing-check', 'authority-ingest', 'rust'])),
    ];
    const client = queuedClient(steps);
    const result = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true, result.message);
    assert(result.effective_required_checks.includes('existing-check'), 'unrelated requirement missing after verification');
  }));

  results.push(await run('missing administration permission is a structured failure with exact authority evidence', async () => {
    const steps = [
      ...commonInitial(),
      ...commonPrecondition(),
      { method: 'POST', result: response(403, { message: 'Resource not accessible by integration' }) },
    ];
    const client = queuedClient(steps);
    const result = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false, 'permission failure became success');
    assert(result.error === 'GITHUB_APP_PERMISSION_DENIED', `unexpected error ${result.error}`);
    assert(result.required_permissions.administration === 'write', 'administration:write evidence missing');
    assert(result.may_have_mutated === true, 'mutation-phase evidence missing');
  }));

  results.push(await run('unknown check rejects before mutation', async () => {
    const client = queuedClient([
      { method: 'GET', result: branchResponse() },
      { method: 'GET', result: response(200, { total_count: 1, check_runs: [{ id: 1, name: 'rust', app: { id: 15368, slug: 'github-actions' } }] }) },
    ]);
    const result = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REQUIRED_CHECK_UNKNOWN', 'unknown check was not rejected');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'unknown-check path mutated GitHub');
  }));

  results.push(await run('material protection change between inspection and write fails closed', async () => {
    const steps = [
      ...commonInitial(),
      { method: 'GET', result: branchResponse() },
      { method: 'GET', result: rulesResponse(['concurrent-check']) },
      { method: 'GET', result: protectionAbsent() },
    ];
    const client = queuedClient(steps);
    const result = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_PROTECTION_CHANGED', 'concurrent change did not fail closed');
    assert(client.calls.every((call) => (call.method || 'GET') === 'GET'), 'concurrency rejection still mutated GitHub');
  }));

  results.push(await run('2xx mutation without authoritative enforcement is not success', async () => {
    const steps = [
      ...commonInitial(),
      ...commonPrecondition(),
      { method: 'POST', result: response(201, { id: 89 }) },
      ...commonVerification(rulesResponse([])),
    ];
    const client = queuedClient(steps);
    const result = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false, 'unverified 2xx became success');
    assert(result.error === 'GITHUB_REQUIRED_CHECKS_VERIFICATION_FAILED', `unexpected error ${result.error}`);
    assert(result.verified !== true, 'failed verification was marked verified');
  }));

  results.push(await run('mutation succeeds, verification transport is lost, and retry converges without duplicate configuration', async () => {
    const desired = rulesResponse(['authority-ingest', 'rust']);
    const steps = [
      ...commonInitial(),
      ...commonPrecondition(),
      { method: 'POST', result: response(201, { id: 90 }) },
      { method: 'GET', result: new Error('verification connection reset') },
      ...commonInitial(desired),
    ];
    const client = queuedClient(steps);
    const first = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {}, maxAttempts: 1 });
    assert(first.ok === false && first.error === 'GITHUB_REQUIRED_CHECKS_INDETERMINATE', `first response was not indeterminate: ${first.error}`);
    assert(first.may_have_mutated === true, 'post-dispatch ambiguity omitted may_have_mutated');
    const second = await ensureGithubRequiredChecks(REQUEST, { apiClient: client, sleep: async () => {}, maxAttempts: 1 });
    assert(second.ok === true && second.outcome === 'already_compliant', 'retry did not converge on authoritative desired state');
    const mutations = client.calls.filter((call) => (call.method || 'GET') !== 'GET');
    assert(mutations.length === 1, `retry performed a duplicate configuration mutation: ${mutations.length}`);
  }));

  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    tests: results,
  };
}