import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIGNIFICANCE_CLASSES,
  assertCandidate,
  assertClassificationDocument,
} from './model.mjs';

test('candidate model accepts complete candidates and rejects incomplete candidates', () => {
  assert.deepEqual(SIGNIFICANCE_CLASSES, [
    'public',
    'authority',
    'durable-internal',
    'boundary-internal',
    'projection',
    'implementation-only',
  ]);

  assert.doesNotThrow(() => assertCandidate({
    source_identity:'typescript:src/example.ts#Example',
    source_kind:'typescript',
    source_location:{ path:'src/example.ts', anchor:'Example' },
    symbol_or_boundary:'Example',
    structural_fingerprint:'sha256:' + 'a'.repeat(64),
    structure:{ declaration_kind:'type' },
    observed_relationships:[],
  }));

  assert.throws(
    () => assertCandidate({ source_identity:'typescript:src/example.ts#Example' }),
    error => error?.code === 'CONTRACT_CANDIDATE_INVALID',
  );
});

test('classification metadata cannot become a second schema authority', () => {
  assert.throws(
    () => assertClassificationDocument({
      schema:'contract-evidence-classifications-v1',
      candidates:{
        'typescript:src/example.ts#Example':{
          logical_contract:'example',
          significance:'public',
          properties:{ value:{ type:'string' } },
        },
      },
    }),
    error => error?.code === 'CONTRACT_CLASSIFICATION_SCHEMA_DUPLICATION',
  );
});
