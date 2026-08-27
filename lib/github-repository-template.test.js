import { commandFailure, commandSuccess } from 'lib/command-response.js';
import { githubAppPermissionProfile } from 'lib/github-app-auth.js';
import { safeRequestProjection, safeResultProjection } from 'lib/orchestration-journal.js';
import {
  createGithubRepositoryFromTemplate,
  ensureGithubRepositoryTemplate,
  normalizeGithubRepositoryFromTemplateCreateRequest,
  normalizeGithubRepositoryTemplateEnsureRequest,
} from 'lib/github-repository-template.js';

const TEMPLATE = 'laurajoyhutchins/template';
const DESTINATION = 'laurajoyhutchins/generated';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }
function response(status, body) { return { status, body, headers: {} }; }
function templateRepo(overrides = {}) {
  return response(200, {
    id: 1,
    full_name: TEMPLATE,
    is_template: true,
    private: false,
    description: 'Template',
    ...overrides,
  });
}
function generatedRepo(overrides = {}) {
  return response(200, {
    id: 2,
    full_name: DESTINATION,
    private: true,
    description: 'Generated for verification',
    html_url: `https://github.com/${DESTINATION}`,
    template_repository: { full_name: TEMPLATE },
    ...overrides,
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
      if (step.path) assert(request.path === step.path, `expected ${step.path}, got ${request.path}`);
      if (step.inspect) step.inspect(request);
      calls.push(request);
      const result = typeof step.result === 'function' ? step.result(request) : step.result;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export async function runGithubRepositoryTemplateTests() {
  const results = [];
  const templatePath = '/repos/laurajoyhutchins/template';
  const destinationPath = '/repos/laurajoyhutchins/generated';
  const generatePath = '/repos/laurajoyhutchins/template/generate';

  results.push(await run('template ensure schema is exact and requires explicit desired state', async () => {
    const normalized = normalizeGithubRepositoryTemplateEnsureRequest({
      repo: TEMPLATE,
      desired_state: { is_template: true },
      expected_state: { is_template: false },
    });
    assert(normalized.repo === TEMPLATE && normalized.desired_state.is_template === true, 'ensure request did not normalize');
    let rejected = false;
    try { normalizeGithubRepositoryTemplateEnsureRequest({ repo: TEMPLATE, desired_state: { is_template: true, visibility: 'public' } }); } catch { rejected = true; }
    assert(rejected, 'unrelated repository metadata was accepted');
  }));

  results.push(await run('template creation schema is narrow and defaults to default-branch generation only', async () => {
    const normalized = normalizeGithubRepositoryFromTemplateCreateRequest({
      template_repo: TEMPLATE,
      destination_repo: DESTINATION,
      description: 'Generated for verification',
      private: true,
      idempotency_key: 'template-create-v1',
    });
    assert(normalized.template_repo === TEMPLATE && normalized.destination_repo === DESTINATION, 'creation coordinates changed');
    for (const invalid of [
      { template_repo: TEMPLATE, destination_repo: DESTINATION, private: true, include_all_branches: true },
      { template_repo: TEMPLATE, destination_repo: DESTINATION },
    ]) {
      let rejected = false;
      try { normalizeGithubRepositoryFromTemplateCreateRequest(invalid); } catch { rejected = true; }
      assert(rejected, 'unsupported or ambiguous creation request was accepted');
    }
  }));

  results.push(await run('repository template permissions are command-owned and narrow', async () => {
    const ensure = githubAppPermissionProfile('repository_template');
    const create = githubAppPermissionProfile('repository_from_template');
    assert(JSON.stringify(ensure) === JSON.stringify({ administration: 'write', metadata: 'read' }), 'template ensure permissions are not narrow');
    assert(JSON.stringify(create) === JSON.stringify({ administration: 'write', contents: 'read' }), 'template creation permissions are not narrow');
  }));

  results.push(await run('already-template state is a verified no-op', async () => {
    const client = queuedClient([{ method: 'GET', path: templatePath, result: templateRepo({ is_template: true }) }]);
    const result = await ensureGithubRepositoryTemplate({ repo: TEMPLATE, desired_state: { is_template: true } }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'already_compliant', result.message || 'no-op failed');
    assert(result.changed === false && result.verified === true, 'no-op did not verify');
    assert(client.calls.length === 1, 'no-op performed extra calls');
  }));

  results.push(await run('template ensure enforces expected state and verifies the write', async () => {
    const client = queuedClient([
      { method: 'GET', path: templatePath, result: templateRepo({ is_template: false }) },
      {
        method: 'PATCH',
        path: templatePath,
        inspect(request) { assert(JSON.stringify(request.body) === JSON.stringify({ is_template: true }), 'template PATCH body was not exact'); },
        result: templateRepo({ is_template: true }),
      },
      { method: 'GET', path: templatePath, result: templateRepo({ is_template: true }) },
    ]);
    const result = await ensureGithubRepositoryTemplate({
      repo: TEMPLATE,
      desired_state: { is_template: true },
      expected_state: { is_template: false },
    }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'updated', result.message || 'template update failed');
    assert(result.changed_fields.join(',') === 'is_template' && result.verified === true, 'template update evidence is incomplete');
  }));

  results.push(await run('stale template expected state fails closed before mutation', async () => {
    const client = queuedClient([{ method: 'GET', path: templatePath, result: templateRepo({ is_template: true }) }]);
    const result = await ensureGithubRepositoryTemplate({
      repo: TEMPLATE,
      desired_state: { is_template: false },
      expected_state: { is_template: false },
    }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_TEMPLATE_STATE_CHANGED', 'stale expected state was not rejected');
    assert(result.may_have_mutated === false, 'precondition conflict claimed mutation');
    assert(client.calls.length === 1, 'stale request mutated GitHub');
  }));

  results.push(await run('ambiguous template write reconciles without replaying mutation', async () => {
    const client = queuedClient([
      { method: 'GET', path: templatePath, result: templateRepo({ is_template: false }) },
      { method: 'PATCH', path: templatePath, result: new Error('connection reset after dispatch') },
      { method: 'GET', path: templatePath, result: templateRepo({ is_template: true }) },
    ]);
    const result = await ensureGithubRepositoryTemplate({ repo: TEMPLATE, desired_state: { is_template: true } }, { apiClient: client, sleep: async () => {}, maxAttempts: 1 });
    assert(result.ok === true && result.outcome === 'reconciled_after_indeterminate_write', result.message || 'ambiguous write did not reconcile');
    assert(client.calls.filter((call) => call.method === 'PATCH').length === 1, 'ambiguous write was replayed');
  }));

  results.push(await run('repository creation requires an authoritative template flag', async () => {
    const client = queuedClient([{ method: 'GET', path: templatePath, result: templateRepo({ is_template: false }) }]);
    const result = await createGithubRepositoryFromTemplate({
      template_repo: TEMPLATE,
      destination_repo: DESTINATION,
      description: 'Generated for verification',
      private: true,
    }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_NOT_TEMPLATE', 'non-template source was accepted');
    assert(result.may_have_mutated === false, 'template precondition failure claimed mutation');
  }));

  results.push(await run('exact existing destination is an idempotent verified no-op', async () => {
    const client = queuedClient([
      { method: 'GET', path: templatePath, result: templateRepo() },
      { method: 'GET', path: destinationPath, result: generatedRepo() },
    ]);
    const result = await createGithubRepositoryFromTemplate({
      template_repo: TEMPLATE,
      destination_repo: DESTINATION,
      description: 'Generated for verification',
      private: true,
      idempotency_key: 'template-create-v1',
    }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'already_exists', result.message || 'idempotent replay failed');
    assert(result.created === false && result.verified === true, 'replay did not preserve existing destination');
    assert(client.calls.every((call) => call.method === 'GET'), 'idempotent replay mutated GitHub');
  }));

  results.push(await run('pre-existing nonmatching destination fails closed', async () => {
    const client = queuedClient([
      { method: 'GET', path: templatePath, result: templateRepo() },
      { method: 'GET', path: destinationPath, result: generatedRepo({ template_repository: null }) },
    ]);
    const result = await createGithubRepositoryFromTemplate({
      template_repo: TEMPLATE,
      destination_repo: DESTINATION,
      description: 'Generated for verification',
      private: true,
    }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === false && result.error === 'GITHUB_REPOSITORY_TEMPLATE_CREATE_CONFLICT', 'nonmatching destination was not rejected');
    assert(result.may_have_mutated === false, 'pre-existing conflict claimed mutation');
  }));

  results.push(await run('create sends the narrow template generation request and verifies exact destination identity', async () => {
    const client = queuedClient([
      { method: 'GET', path: templatePath, result: templateRepo() },
      { method: 'GET', path: destinationPath, result: response(404, { message: 'Not Found' }) },
      {
        method: 'POST',
        path: generatePath,
        inspect(request) {
          assert(JSON.stringify(request.body) === JSON.stringify({
            owner: 'laurajoyhutchins',
            name: 'generated',
            description: 'Generated for verification',
            include_all_branches: false,
            private: true,
          }), `unexpected generate body ${JSON.stringify(request.body)}`);
        },
        result: response(201, generatedRepo().body),
      },
      { method: 'GET', path: destinationPath, result: generatedRepo() },
    ]);
    const result = await createGithubRepositoryFromTemplate({
      template_repo: TEMPLATE,
      destination_repo: DESTINATION,
      description: 'Generated for verification',
      private: true,
    }, { apiClient: client, sleep: async () => {} });
    assert(result.ok === true && result.outcome === 'created', result.message || 'creation failed');
    assert(result.repository_id === 2 && result.template_repository === TEMPLATE && result.verified === true, 'creation result lacks authoritative identity');
  }));

  results.push(await run('ambiguous create reconciles by exact destination and never replays POST', async () => {
    const client = queuedClient([
      { method: 'GET', path: templatePath, result: templateRepo() },
      { method: 'GET', path: destinationPath, result: response(404, { message: 'Not Found' }) },
      { method: 'POST', path: generatePath, result: new Error('connection reset after dispatch') },
      { method: 'GET', path: destinationPath, result: generatedRepo() },
    ]);
    const result = await createGithubRepositoryFromTemplate({
      template_repo: TEMPLATE,
      destination_repo: DESTINATION,
      description: 'Generated for verification',
      private: true,
    }, { apiClient: client, sleep: async () => {}, maxAttempts: 1 });
    assert(result.ok === true && result.outcome === 'reconciled_after_indeterminate_create', result.message || 'ambiguous create did not reconcile');
    assert(client.calls.filter((call) => call.method === 'POST').length === 1, 'ambiguous create was replayed');
  }));

  results.push(await run('command response and journal projections register template semantics without storing description text', async () => {
    const ensureSuccess = commandSuccess('github.repository_template.ensure', { ok: true, outcome: 'updated' });
    const createFailure = commandFailure('github.repository_from_template.create', {
      ok: false,
      error: 'GITHUB_REPOSITORY_TEMPLATE_CREATE_INDETERMINATE',
      message: 'uncertain',
      may_have_mutated: true,
    });
    assert(ensureSuccess.command === 'github.repository_template.ensure', 'template ensure canonical command is not registered');
    assert(createFailure.body.retryable === true && createFailure.body.recommended_action === 'reconcile_external_effect', 'create indeterminate recovery semantics are wrong');

    const requestProjection = safeRequestProjection('github.repository_from_template.create', {
      template_repo: TEMPLATE,
      destination_repo: DESTINATION,
      description: 'do not persist this text',
      private: true,
      idempotency_key: 'template-create-v1',
    });
    assert(requestProjection.template_repo === TEMPLATE && requestProjection.destination_repo === DESTINATION, 'create request projection lost coordinates');
    assert(!JSON.stringify(requestProjection).includes('do not persist this text'), 'journal projection stored repository description');
    const resultProjection = safeResultProjection('github.repository_from_template.create', {
      template_repo: TEMPLATE,
      destination_repo: DESTINATION,
      repository_id: 2,
      outcome: 'created',
      created: true,
      verified: true,
    });
    assert(resultProjection.repository_id === 2 && resultProjection.verified === true, 'create result projection lost verification');
  }));

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}
