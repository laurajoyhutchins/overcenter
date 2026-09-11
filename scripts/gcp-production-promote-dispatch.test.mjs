import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/gcp-production-promote.yml', import.meta.url), 'utf8');

test('GCP production promotion is explicitly dispatchable and remains semantically fenced', () => {
  assert.match(workflow, /on:\n\s+workflow_dispatch:/);
  assert.match(workflow, /exact_revision:/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$EXACT_REVISION"/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/dev/);
  assert.match(workflow, /"command":"production\.promote"/);
  assert.match(workflow, /\.source_revision == \$revision and \.production_revision == \$revision/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/);
});
