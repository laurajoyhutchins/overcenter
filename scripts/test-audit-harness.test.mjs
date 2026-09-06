import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTestRepository } from './test-audit-harness.mjs';

test('test audit binds a complete census to one exact revision', async () => {
  const audit = await auditTestRepository({
    root: new URL('../', import.meta.url),
    revision: '0123456789abcdef0123456789abcdef01234567',
  });

  assert.equal(audit.schema, 'overcenter-test-audit-v1');
  assert.equal(audit.revision, '0123456789abcdef0123456789abcdef01234567');
  assert.ok(audit.files.length > 0);
  assert.ok(audit.cases.length > 0);
  assert.equal(new Set(audit.files.map((entry) => entry.id)).size, audit.files.length);
  assert.equal(new Set(audit.cases.map((entry) => entry.id)).size, audit.cases.length);
  assert.ok(audit.files.every((entry) => entry.id.startsWith('file:')));
  assert.ok(audit.cases.every((entry) => entry.id.startsWith('case:')));
  assert.ok(Array.isArray(audit.unresolved));
});