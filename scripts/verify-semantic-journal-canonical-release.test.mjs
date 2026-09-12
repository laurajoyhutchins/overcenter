import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/orchestration-semantic-journal-resolution.js', import.meta.url), 'utf8');

test('release journal reconciliation is bound to canonical execution settlement', () => {
  assert.match(source, /lookupReleaseExecution/);
  assert.match(source, /FROM execution_state/);
  assert.match(source, /JOIN operation_state/);
  assert.match(source, /settlement_receipt/);
  assert.doesNotMatch(source, /github_release_receipts/);
});

test('release reconciliation requires exact repository, tag, target revision, and request identity', () => {
  assert.match(source, /authority_revision/);
  assert.match(source, /subject_key/);
  assert.match(source, /idempotency_key/);
  assert.match(source, /operation_kind = 'github\.release\.create'/);
});
