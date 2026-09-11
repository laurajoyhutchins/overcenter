import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowsUrl = new URL('../.github/workflows/', import.meta.url);

test('GCP deployment surfaces have no one-shot or semantic-command workflow bridge', async () => {
  const workflows = (await readdir(workflowsUrl)).sort();
  assert.deepEqual(workflows.filter((name) => name.endsWith('-once.yml')), []);
  assert.equal(workflows.includes('gcp-semantic-command.yml'), false);
});

test('provider-neutral exact-revision workflow replaces the V8-named survivor', async () => {
  const workflows = (await readdir(workflowsUrl)).sort();
  assert.equal(workflows.includes('exact-revision.yml'), true);
  assert.equal(workflows.includes('exact-revision-v8.yml'), false);
});

test('orchestration maintenance follows only successful replacement exact-revision checks', async () => {
  const workflow = await readFile(new URL('../.github/workflows/gcp-orchestration-maintain.yml', import.meta.url), 'utf8');
  assert.match(workflow, /Exact revision verification/);
  assert.doesNotMatch(workflow, /Exact revision V8 verification/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
});
