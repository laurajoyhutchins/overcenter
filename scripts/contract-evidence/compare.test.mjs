import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCatalogs, compareUnclassified } from './compare.mjs';

function catalog(fingerprint, unclassified = []) {
  return {
    schema:'contract-evidence-catalog-v1',
    repository:{ root_marker:'.' },
    generated_by:{ protocol:'contract-evidence-catalog-v1' },
    candidates:[],
    logical_contracts:[{
      id:'work.settle.input',
      authority:{
        source_identity:'typescript:src/work.ts#Input',
        source_kind:'typescript',
        significance:'public',
        semver_kind:'semantic-command-contract',
        structural_fingerprint:fingerprint,
      },
      projections:[],
    }],
    unclassified_source_identities:unclassified,
    summary:{ discovered:0, classified:0, unclassified:unclassified.length, logical_contracts:1 },
  };
}

test('unclassified debt can shrink but can never be swapped for new debt', () => {
  assert.equal(compareUnclassified(['A','B','C'], ['A','C']).ok, true);
  assert.deepEqual(compareUnclassified(['A','B','C'], ['A','B','D']).new_unclassified, ['D']);
  assert.equal(compareUnclassified([], []).ok, true);
  assert.deepEqual(compareUnclassified([], ['A']).new_unclassified, ['A']);
});

test('catalog comparison reports structural compatibility facts without version judgment', () => {
  const result = compareCatalogs(
    catalog('sha256:' + 'a'.repeat(64)),
    catalog('sha256:' + 'b'.repeat(64)),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed_contracts, [{
    logical_contract:'work.settle.input',
    semver_kind:'semantic-command-contract',
    base_fingerprint:'sha256:' + 'a'.repeat(64),
    head_fingerprint:'sha256:' + 'b'.repeat(64),
    changed:true,
  }]);
  assert.equal('major' in result, false);
  assert.equal('minor' in result, false);
  assert.equal('patch' in result, false);
});
