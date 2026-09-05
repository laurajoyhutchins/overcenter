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
  assert.match(workflow, /codex login status/);
  assert.match(workflow, /env -u OPENAI_API_KEY -u CODEX_API_KEY/);
  assert.match(workflow, /codex exec/);
  assert.match(workflow, /--ephemeral/);
  assert.match(workflow, /--sandbox workspace-write/);
  assert.match(workflow, /--output-schema/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
});

test('deterministic wrapper acquires the packet and applies Codex edits through the lease', async () => {
  const source = await repositoryText('scripts/codex-project-agent-execution.mjs');

  assert.match(source, /connectHatchableRemoteMcp/);
  assert.match(source, /project\.advance/);
  assert.match(source, /AGENT_EXECUTION_REQUIRED/);
  assert.match(source, /execution_intent/);
  assert.match(source, /authority\.revision/);
  assert.match(source, /github\.apply_changeset/);
  assert.match(source, /lease_ref/);
  assert.match(source, /git diff/);
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