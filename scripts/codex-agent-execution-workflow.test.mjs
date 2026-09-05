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