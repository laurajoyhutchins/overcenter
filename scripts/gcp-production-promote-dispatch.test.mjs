import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/gcp-production-promote-once.yml', import.meta.url), 'utf8');

test('GCP production promotion is explicitly dispatchable and remains semantically fenced', () => {
  assert.match(workflow, /on:\n\s+workflow_dispatch:/);
  assert.match(workflow, /push:\n\s+branches: \[dev\]/);
  assert.match(workflow, /Wait for exact-revision verification/);
  assert.match(workflow, /"command":"production\.promote"/);
  assert.match(workflow, /\.source_revision == \$revision and \.production_revision == \$revision/);
  assert.match(workflow, /git ls-remote .*refs\/heads\/main/);
});
