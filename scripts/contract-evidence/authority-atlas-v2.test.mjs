import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertClassificationDocument,
  renderAuthorityAtlasMarkdown,
  resolveLogicalContracts,
} from '../../packages/contract-evidence/index.mjs';

const fp = (letter) => `sha256:${letter.repeat(64)}`;

function candidate(sourceIdentity, letter) {
  return {
    source_identity:sourceIdentity,
    source_kind:'typescript',
    source_location:{ path:`src/${sourceIdentity}.ts`, anchor:sourceIdentity },
    symbol_or_boundary:sourceIdentity,
    structural_fingerprint:fp(letter),
    structure:{ type:'fixture' },
    observed_relationships:[],
  };
}

function fixture() {
  return {
    candidates:[
      candidate('host', 'a'),
      candidate('input', 'b'),
      candidate('evidence', 'c'),
    ],
    classifications:{
      schema:'contract-evidence-classifications-v1',
      candidates:{
        host:{
          logical_contract:'project.advance.runtime-host',
          significance:'boundary-internal',
          lifecycle:'current',
          relationships:[
            { kind:'produces', target:'execution.evidence' },
            { kind:'consumes', target:'project.advance.input' },
          ],
        },
        input:{
          logical_contract:'project.advance.input',
          significance:'public',
          lifecycle:'current',
          semver_kind:'semantic-command-contract',
        },
        evidence:{
          logical_contract:'execution.evidence',
          significance:'public',
          lifecycle:'current',
          semver_kind:'public-evidence-schema',
        },
      },
    },
  };
}

test('classification metadata accepts lifecycle and typed logical-contract relationships', () => {
  const { classifications } = fixture();
  const document = assertClassificationDocument(classifications);
  assert.equal(document.candidates.host.lifecycle, 'current');
  assert.deepEqual(document.candidates.host.relationships, [
    { kind:'produces', target:'execution.evidence' },
    { kind:'consumes', target:'project.advance.input' },
  ]);

  assert.throws(
    () => assertClassificationDocument({
      ...classifications,
      candidates:{ ...classifications.candidates, host:{ ...classifications.candidates.host, lifecycle:'legacy' } },
    }),
    (error) => error?.code === 'CONTRACT_CLASSIFICATION_INVALID',
  );
  assert.throws(
    () => assertClassificationDocument({
      ...classifications,
      candidates:{ ...classifications.candidates, host:{ ...classifications.candidates.host, relationships:[{ kind:'calls', target:'project.advance.input' }] } },
    }),
    (error) => error?.code === 'CONTRACT_CLASSIFICATION_INVALID',
  );
});

test('resolver carries deterministic relationships and rejects missing logical targets', () => {
  const { candidates, classifications } = fixture();
  const resolution = resolveLogicalContracts(candidates, classifications);
  const host = resolution.logical_contracts.find((item) => item.id === 'project.advance.runtime-host');
  assert.equal(host.lifecycle, 'current');
  assert.deepEqual(host.relationships, [
    { kind:'consumes', target:'project.advance.input' },
    { kind:'produces', target:'execution.evidence' },
  ]);

  const broken = structuredClone(classifications);
  broken.candidates.host.relationships.push({ kind:'verified-by', target:'missing.contract' });
  assert.throws(
    () => resolveLogicalContracts(candidates, broken),
    (error) => error?.code === 'CONTRACT_RELATIONSHIP_TARGET_MISSING',
  );
});

test('authority atlas renders lifecycle plus outgoing and mechanically reversed incoming flow edges', () => {
  const { candidates, classifications } = fixture();
  const resolution = resolveLogicalContracts(candidates, classifications);
  const catalog = { schema:'contract-evidence-catalog-v1', candidates:resolution.candidates, logical_contracts:resolution.logical_contracts };
  const first = renderAuthorityAtlasMarkdown(catalog);
  const second = renderAuthorityAtlasMarkdown(catalog);
  assert.equal(first, second);
  assert.match(first, /## Flow index/);
  assert.match(first, /`project\.advance\.runtime-host` → `consumes` → `project\.advance\.input`/);
  assert.match(first, /- Lifecycle: `current`/);
  assert.match(first, /### Outgoing relationships[\s\S]*`consumes` → `project\.advance\.input`/);
  assert.match(first, /## `project\.advance\.input`[\s\S]*### Incoming relationships[\s\S]*`project\.advance\.runtime-host` → `consumes`/);
});
