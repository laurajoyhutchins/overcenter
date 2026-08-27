import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedEvidenceProjection, boundedEvidenceText } from '../lib/bounded-evidence.js';

test('bounded execution evidence projection drops secret-bearing and body/content keys', () => {
  const projected = boundedEvidenceProjection({
    safe: 'yes',
    token: 'drop',
    credential: 'drop',
    nested: { password: 'drop', body: 'drop', keep: 'ok' },
  });
  assert.equal(projected.safe, 'yes');
  assert.equal(projected.token, undefined);
  assert.equal(projected.credential, undefined);
  assert.equal(projected.nested.keep, 'ok');
  assert.equal(projected.nested.password, undefined);
  assert.equal(projected.nested.body, undefined);
});

test('bounded execution evidence projection enforces string array object and depth bounds', () => {
  const projected = boundedEvidenceProjection({
    long: 'x'.repeat(5000),
    list: Array.from({ length: 40 }, (_, index) => index),
    ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${String(index).padStart(2, '0')}`, index])),
  });
  assert.equal(projected.long.length, 1024);
  assert.equal(projected.list.length, 25);
  assert.ok(Object.keys(projected).length <= 30);

  const deep = boundedEvidenceProjection({ a: { b: { c: { d: { e: 'value' } } } } });
  assert.equal(typeof deep.a.b.c.d, 'string');
});

test('bounded execution evidence text is normalized consistently', () => {
  assert.equal(boundedEvidenceText('  abc  ', 10), 'abc');
  assert.equal(boundedEvidenceText('', 10), null);
  assert.equal(boundedEvidenceText('abcdefghijk', 4), 'abcd');
});
