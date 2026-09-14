import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/gcp-authoritative-deploy.yml', import.meta.url), 'utf8');

test('authoritative deployment fences the exact dev revision without requiring main lockstep', () => {
  assert.match(workflow, /refs\/heads\/dev/);
  assert.match(workflow, /ls-remote origin refs\/heads\/dev/);
  assert.doesNotMatch(workflow, /refs\/heads\/main/);
  assert.doesNotMatch(workflow, /promoted to both dev and main/);
});

test('authoritative deployment remains explicit workflow dispatch with an exact revision input', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /ref: \$\{\{ inputs\.exact_revision \}\}/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.doesNotMatch(workflow, /inputs\.exact_revision \|\| github\.sha/);
});
