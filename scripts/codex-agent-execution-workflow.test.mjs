import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runGcpSemanticCommand } from './gcp-semantic-command-client.mjs';

const root = new URL('../', import.meta.url);

async function repositoryText(path) {
  try {
    return await readFile(new URL(path, root), 'utf8');
  } catch {
    return '';
  }
}

test('Codex agent execution is manual, exact-revision, subscription authenticated, and GCP authoritative', async () => {
  const workflow = await repositoryText('.github/workflows/codex-agent-execution.yml');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on:\s*\[self-hosted,\s*codex\]/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/);
  assert.match(workflow, /OVERCENTER_ID_TOKEN/);
  assert.match(workflow, /OVERCENTER_SERVICE_URL/);
  assert.match(workflow, /codex-project-agent-execution\.mjs prepare/);
  assert.match(workflow, /codex-project-agent-execution\.mjs execute/);
  assert.match(workflow, /codex-project-agent-execution\.mjs apply/);
  assert.match(workflow, /steps\.prepare\.outputs\.revision/);
  assert.doesNotMatch(workflow, /HATCHABLE_TOKEN|OVERCENTER_HATCHABLE_PRODUCTION_PROJECT/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
});

test('deterministic wrapper owns authority, ChatGPT auth enforcement, and lease-scoped mutation without Hatchable transport', async () => {
  const source = await repositoryText('scripts/codex-project-agent-execution.mjs');

  assert.match(source, /runGcpSemanticCommand/);
  assert.doesNotMatch(source, /connectHatchableRemoteMcp|HATCHABLE_TOKEN|OVERCENTER_HATCHABLE_PRODUCTION_PROJECT/);
  assert.match(source, /project\.advance/);
  assert.match(source, /AGENT_EXECUTION_REQUIRED/);
  assert.match(source, /execution_intent/);
  assert.match(source, /authority\.revision/);
  assert.match(source, /github\.apply_changeset/);
  assert.match(source, /lease_ref/);
  assert.match(source, /git diff/);
  assert.match(source, /delete childEnv\.OPENAI_API_KEY/);
  assert.match(source, /delete childEnv\.CODEX_API_KEY/);
  assert.match(source, /\['login',\s*'status'\]/);
  assert.match(source, /Logged in using ChatGPT/);
  assert.match(source, /\['exec'/);
  assert.match(source, /--ephemeral/);
  assert.match(source, /--sandbox/);
  assert.match(source, /workspace-write/);
  assert.match(source, /--output-schema/);
});

test('GCP command transport sends one authoritative request and never retries uncertainty', async () => {
  const calls = [];
  const result = await runGcpSemanticCommand({
    serviceUrl: 'https://overcenter.example.test',
    idToken: 'token',
    requestId: 'codex:1:prepare',
    command: 'project.advance',
    input: { project_ref: 'github:laurajoyhutchins/overcenter' },
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://overcenter.example.test/api/worker-command');
  assert.equal(calls[0][1].headers.authorization, 'Bearer token');
  assert.equal(calls[0][1].headers['x-overcenter-authority-mode'], 'authoritative');
  assert.equal(calls[0][1].headers['x-overcenter-request-id'], 'codex:1:prepare');

  let attempts = 0;
  await assert.rejects(
    runGcpSemanticCommand({
      serviceUrl: 'https://overcenter.example.test',
      idToken: 'token',
      requestId: 'codex:1:apply',
      command: 'github.apply_changeset',
      input: {},
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError('socket reset');
      },
    }),
    error => error.code === 'OVERCENTER_COMMAND_OUTCOME_INDETERMINATE'
      && error.details.may_have_mutated === true
      && error.details.automatic_recovery_allowed === false
      && error.details.escalation_required === true,
  );
  assert.equal(attempts, 1);
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
