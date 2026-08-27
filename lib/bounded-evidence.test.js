import { boundedEvidenceProjection, boundedEvidenceText } from 'lib/bounded-evidence.js';

function assert(condition, message) { if (!condition) throw new Error(message); }

export async function runBoundedEvidenceTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('drops secret-bearing and body/content keys at every object level', async () => {
    const projected = boundedEvidenceProjection({
      safe: 'yes',
      token: 'drop',
      credential: 'drop',
      nested: { password: 'drop', body: 'drop', keep: 'ok' },
    });
    assert(projected.safe === 'yes', 'safe field missing');
    assert(projected.token === undefined && projected.credential === undefined, 'top-level secret leaked');
    assert(projected.nested.keep === 'ok', 'nested safe field missing');
    assert(projected.nested.password === undefined && projected.nested.body === undefined, 'nested secret leaked');
  });

  await test('bounds strings, arrays, keys, and object breadth deterministically', async () => {
    const projected = boundedEvidenceProjection({
      long: 'x'.repeat(5000),
      list: Array.from({ length: 40 }, (_, index) => index),
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${String(index).padStart(2, '0')}`, index])),
    });
    assert(projected.long.length === 1024, 'string was not bounded');
    assert(projected.list.length === 25, 'array was not bounded');
    assert(Object.keys(projected).length <= 30, 'object breadth was not bounded');
  });

  await test('bounds excessive nesting instead of traversing indefinitely', async () => {
    const projected = boundedEvidenceProjection({ a: { b: { c: { d: { e: 'value' } } } } });
    assert(typeof projected.a.b.c.d === 'string', 'deep value was not collapsed');
  });

  await test('normalizes receipt text consistently', async () => {
    assert(boundedEvidenceText('  abc  ', 10) === 'abc', 'text was not trimmed');
    assert(boundedEvidenceText('', 10) === null, 'empty text was not null');
    assert(boundedEvidenceText('abcdefghijk', 4) === 'abcd', 'text was not bounded');
  });

  return {
    ok: results.every((entry) => entry.ok),
    passed: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    total: results.length,
    results,
  };
}
