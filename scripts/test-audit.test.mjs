import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditTestCensus } from './test-audit-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('test audit census is exhaustive and revision-bound', async () => {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd:root, encoding:'utf8' }).trim();
  const audit = await auditTestCensus({ root:path.resolve(root), revision });
  assert.equal(audit.revision, revision);
  assert.ok(audit.files.length > 0, 'expected supported test files');
  assert.ok(audit.cases.length > 0, 'expected literal test cases');
  assert.deepEqual(audit.unresolved, [], `unresolved test shapes:\n${JSON.stringify(audit.unresolved, null, 2)}`);
  assert.equal(new Set(audit.cases.map(({ id }) => id)).size, audit.cases.length, 'audit IDs must be unique at one revision');
});