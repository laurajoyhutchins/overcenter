import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, fingerprintStructure } from './canonical.mjs';
import { compileCatalog } from './compiler.mjs';

function fixtureCandidate(id) {
  return {
    source_identity:id,
    source_kind:'fixture',
    source_location:{ path:'contracts.json', anchor:id },
    symbol_or_boundary:id,
    structural_fingerprint:fingerprintStructure({ id }),
    structure:{ id },
    observed_relationships:[],
  };
}

test('configured discoverer failure is a hard catalog failure', async () => {
  const failing = {
    name:'failing',
    async discover() { throw Object.assign(new Error('boom'), { code:'FIXTURE_BOOM' }); },
  };
  await assert.rejects(
    compileCatalog({ repoRoot:'.', discoverers:[failing], classificationDocument:{ schema:'contract-evidence-classifications-v1', candidates:{} } }),
    error => error?.code === 'CONTRACT_DISCOVERY_FAILED' && error.discoverer === 'failing',
  );
});

test('incomplete discoverer result is never treated as an empty source family', async () => {
  const incomplete = {
    name:'incomplete',
    async discover() { return { complete:false, candidates:[], diagnostics:[{ code:'PARTIAL' }] }; },
  };
  await assert.rejects(
    compileCatalog({ repoRoot:'.', discoverers:[incomplete], classificationDocument:{ schema:'contract-evidence-classifications-v1', candidates:{} } }),
    error => error?.code === 'CONTRACT_DISCOVERY_INCOMPLETE' && error.discoverer === 'incomplete',
  );
});

test('catalog output is deterministic regardless of discoverer ordering', async () => {
  const first = fixtureCandidate('fixture:contracts.json#A');
  const second = fixtureCandidate('fixture:contracts.json#B');
  const left = await compileCatalog({
    repoRoot:'.',
    discoverers:[{ name:'one', async discover() { return { complete:true, candidates:[second, first], diagnostics:[] }; } }],
    classificationDocument:{ schema:'contract-evidence-classifications-v1', candidates:{} },
  });
  const right = await compileCatalog({
    repoRoot:'.',
    discoverers:[{ name:'one', async discover() { return { complete:true, candidates:[first, second], diagnostics:[] }; } }],
    classificationDocument:{ schema:'contract-evidence-classifications-v1', candidates:{} },
  });
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.deepEqual(left.repository, { root_marker:'.' });
  assert.deepEqual(left.generated_by, { protocol:'contract-evidence-catalog-v1' });
  assert.equal('revision' in left.repository, false);
  assert.equal('generated_at' in left, false);
});
