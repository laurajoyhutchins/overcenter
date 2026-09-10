import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function repositoryText(path) {
  try {
    return await readFile(new URL(path, root), 'utf8');
  } catch {
    return '';
  }
}

test('Codex agent execution is manual, exact-revision, and subscription authenticated', async () => {
  const workflow = await repositoryText('.github/workflows/codex-agent-execution.yml');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on:\s*\[self-hosted,\s*codex\]/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /HATCHABLE_TOKEN/);
  assert.match(workflow, /codex-project-agent-execution\.mjs prepare/);
  assert.match(workflow, /codex-project-agent-execution\.mjs execute/);
  assert.match(workflow, /codex-project-agent-execution\.mjs apply/);
  assert.match(workflow, /steps\.prepare\.outputs\.revision/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
});

test('deterministic wrapper owns authority, ChatGPT auth enforcement, and lease-scoped mutation', async () => {
  const source = await repositoryText('scripts/codex-project-agent-execution.mjs');

  assert.match(source, /connectHatchableRemoteMcp/);
  assert.match(source, /project\.advance/);
  assert.match(source, /AGENT_EXECUTION_REQUIRED/);
  assert.match(source, /execution_intent/);
  assert.match(source, /authority\.revision/);
  assert.match(source, /github\.apply_changeset/);
  assert.match(source, /lease_ref/);
  assert.match(source, /git diff/);
  assert.match(source, /delete childEnv\.OPENAI_API_KEY/);
  assert.match(source, /delete childEnv\.CODEX_API_KEY/);
  assert.match(source, /delete childEnv\.HATCHABLE_TOKEN/);
  assert.match(source, /\['login',\s*'status'\]/);
  assert.match(source, /Logged in using ChatGPT/);
  assert.match(source, /\['exec'/);
  assert.match(source, /--ephemeral/);
  assert.match(source, /--sandbox/);
  assert.match(source, /workspace-write/);
  assert.match(source, /--output-schema/);
});

test('Codex execution isolation rejects identity gaps and unrepresentable workspace changes', async () => {
  const source = await repositoryText('scripts/codex-project-agent-execution.mjs');

  assert.match(source, /const SHA256 = \/\^\[0-9a-f\]\{64\}\$\//);
  assert.match(source, /transition_definition_fingerprint/);
  assert.match(source, /lstat/);
  assert.match(source, /--no-renames/);
  assert.doesNotMatch(source, /const childEnv = \{ \.\.\.process\.env \}/);
  assert.doesNotMatch(source, /boundedReceipt = \{[\s\S]{0,500}lease_ref:/);
});

test('Codex output has a bounded machine-readable contract', async () => {
  const schema = await repositoryText('schemas/codex-agent-execution-result.schema.json');
  const parsed = JSON.parse(schema || '{}');

  assert.equal(parsed.type, 'object');
  assert.equal(parsed.additionalProperties, false);
  assert.deepEqual(parsed.required, ['status', 'summary', 'evidence']);
  assert.deepEqual(parsed.properties?.status?.enum, ['completed', 'blocked']);
  assert.equal(parsed.properties?.evidence?.type, 'array');
});

test('repository execution is routed through a provider-neutral exact-revision contract', async () => {
  const contract = await repositoryText('lib/exact-revision-repository-executor.js');
  const worker = await repositoryText('scripts/codex-project-agent-execution.mjs');

  assert.match(contract, /repository-executor-request-v1/);
  assert.match(contract, /authority_revision/);
  assert.match(contract, /transition_id/);
  assert.match(contract, /lease_ref/);
  assert.match(contract, /network_policy/);
  assert.match(contract, /executor_identity/);
  assert.match(contract, /executor_fingerprint/);
  assert.match(contract, /validateRepositoryExecutionResult/);
  assert.match(worker, /exact-revision-repository-executor\.js/);
});

test('repository executor requests preserve semantic authority across provider substitution and fence result identity', async () => {
  const { bindRepositoryExecutionResult, createRepositoryExecutionRequest, validateRepositoryExecutionResult } = await import('../lib/exact-revision-repository-executor.js');
  const packet = {
    project_ref: 'github:example/repo',
    repository: 'example/repo',
    authority: { revision: '1111111111111111111111111111111111111111' },
    transition_id: 'example-transition',
    lease_ref: 'lease-1',
    resume_ref: 'resume-1',
    run_id: 'run-1',
    transition_definition_fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
    execution_intent: { acceptance_evidence: [{ kind: 'test', requirement: 'prove it' }] },
    authorized_mutations: ['github.apply_changeset'],
  };
  const first = createRepositoryExecutionRequest(packet, {
    executor_identity: 'github-actions-codex',
    executor_fingerprint: '3333333333333333333333333333333333333333333333333333333333333333',
    network_policy: 'restricted',
  });
  const second = createRepositoryExecutionRequest(packet, {
    executor_identity: 'disposable-vm',
    executor_fingerprint: '4444444444444444444444444444444444444444444444444444444444444444',
    network_policy: 'disabled',
  });

  assert.equal(first.authority_revision, second.authority_revision);
  assert.equal(first.transition_id, second.transition_id);
  assert.equal(first.lease_ref, second.lease_ref);
  assert.deepEqual(first.mutation_budget, ['github.apply_changeset']);
  assert.equal(first.capabilities.repository_mutation, false);
  assert.notEqual(first.executor_identity, second.executor_identity);

  const bound = bindRepositoryExecutionResult(first, { status: 'completed', summary: 'done', evidence: [{ kind: 'test', detail: 'green' }] });
  assert.equal(validateRepositoryExecutionResult(bound, first).status, 'completed');
  assert.deepEqual(bound.capabilities, { network_policy: 'restricted', repository_mutation: false });
  assert.throws(() => validateRepositoryExecutionResult({ ...bound, authority_revision: '5555555555555555555555555555555555555555' }, first), /does not match request/);
  assert.throws(() => validateRepositoryExecutionResult({ ...bound, lease_ref: 'stale-lease' }, first), /does not match request/);
  assert.throws(() => validateRepositoryExecutionResult({ ...bound, run_id: 'other-run' }, first), /does not match request/);
  assert.throws(() => validateRepositoryExecutionResult({ ...bound, transition_definition_fingerprint: '6'.repeat(64) }, first), /does not match request/);
  assert.throws(() => validateRepositoryExecutionResult({ ...bound, executor_identity: 'other' }, first), /does not match request/);
  assert.throws(() => validateRepositoryExecutionResult({ ...bound, capabilities: { ...bound.capabilities, network_policy: 'unrestricted' } }, first), /capabilities do not match request/);
  assert.throws(() => bindRepositoryExecutionResult(first, { status: 'completed', summary: 'x'.repeat(4097), evidence: [{ kind: 'test', detail: 'green' }] }), /summary is invalid/);
  assert.throws(() => bindRepositoryExecutionResult(first, { status: 'completed', summary: 'done', evidence: Array.from({ length: 33 }, () => ({ kind: 'test', detail: 'green' })) }), /evidence is invalid/);
  assert.throws(() => createRepositoryExecutionRequest(packet, {
    executor_identity: 'unsafe-provider',
    executor_fingerprint: '7'.repeat(64),
    network_policy: 'ambient',
  }), /network_policy is invalid/);
});