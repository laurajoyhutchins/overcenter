import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, fingerprintStructure, sourceIdentity } from './canonical.mjs';

test('canonical JSON and fingerprints ignore object-key order', () => {
  assert.equal(canonicalJson({ b:2, a:{ d:4, c:3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(
    fingerprintStructure({ type:'object', properties:{ b:{type:'string'}, a:{type:'number'} } }),
    fingerprintStructure({ properties:{ a:{type:'number'}, b:{type:'string'} }, type:'object' }),
  );
});

test('source identities normalize paths and reject traversal', () => {
  assert.equal(
    sourceIdentity('typescript', 'src\\semantic\\foo.ts', 'Foo'),
    'typescript:src/semantic/foo.ts#Foo',
  );
  assert.throws(
    () => sourceIdentity('typescript', '../escape.ts', 'Escape'),
    error => error?.code === 'CONTRACT_SOURCE_IDENTITY_INVALID',
  );
});
