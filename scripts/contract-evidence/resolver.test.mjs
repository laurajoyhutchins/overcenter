import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveLogicalContracts,
  unclassifiedSourceIdentities,
} from './resolver.mjs';

function candidate(source_identity, relationships = []) {
  const [prefix, rest] = source_identity.split(':', 2);
  return {
    source_identity,
    source_kind:prefix,
    source_location:{ path:rest.split('#')[0], anchor:rest.split('#')[1] },
    symbol_or_boundary:rest.split('#')[1],
    structural_fingerprint:'sha256:' + 'a'.repeat(64),
    structure:{ kind:'fixture' },
    observed_relationships:relationships,
  };
}

function classifications(candidates) {
  return { schema:'contract-evidence-classifications-v1', candidates };
}

const allowedSemverKinds = new Set(['semantic-command-contract', 'database-layout']);

test('resolves one authority, one projection, and explicit unclassified debt', () => {
  const resolution = resolveLogicalContracts([
    candidate('typescript:src/semantic/work-settle-contract.ts#WorkSettleInput'),
    candidate('mcp:mcp/work.settle.js#inputSchema'),
    candidate('typescript:src/internal.ts#LegacyShape'),
  ], classifications({
    'typescript:src/semantic/work-settle-contract.ts#WorkSettleInput':{
      logical_contract:'work.settle.input',
      significance:'public',
      semver_kind:'semantic-command-contract',
    },
    'mcp:mcp/work.settle.js#inputSchema':{
      significance:'projection',
      projection_of:'work.settle.input',
    },
  }), { allowedSemverKinds });

  assert.equal(resolution.logical_contracts.length, 1);
  assert.equal(resolution.logical_contracts[0].id, 'work.settle.input');
  assert.equal(resolution.logical_contracts[0].authority.source_identity, 'typescript:src/semantic/work-settle-contract.ts#WorkSettleInput');
  assert.deepEqual(resolution.logical_contracts[0].projections.map((item) => item.source_identity), ['mcp:mcp/work.settle.js#inputSchema']);
  assert.deepEqual(unclassifiedSourceIdentities(resolution), ['typescript:src/internal.ts#LegacyShape']);
});

test('generated mirrors are projections and never duplicate unclassified debt', () => {
  const authority = candidate('typescript:src/contracts.ts#REQUEST_SCHEMA');
  const generated = candidate('javascript:lib/contracts.js#REQUEST_SCHEMA', [
    { kind:'generated-projection-of', target:'typescript:src/contracts.ts#REQUEST_SCHEMA' },
  ]);

  const classified = resolveLogicalContracts([authority, generated], classifications({
    'typescript:src/contracts.ts#REQUEST_SCHEMA':{
      logical_contract:'request.schema',
      significance:'authority',
    },
  }), { allowedSemverKinds });
  assert.deepEqual(classified.logical_contracts[0].projections.map((item) => item.source_identity), ['javascript:lib/contracts.js#REQUEST_SCHEMA']);
  assert.deepEqual(unclassifiedSourceIdentities(classified), []);

  const historical = resolveLogicalContracts([authority, generated], classifications({}), { allowedSemverKinds });
  assert.deepEqual(unclassifiedSourceIdentities(historical), ['typescript:src/contracts.ts#REQUEST_SCHEMA']);
});

test('resolver fails closed on inconsistent identity and authority relationships', () => {
  const a = candidate('typescript:src/a.ts#A');
  const b = candidate('typescript:src/b.ts#B');
  assert.throws(
    () => resolveLogicalContracts([a, a], classifications({}), { allowedSemverKinds }),
    error => error?.code === 'CONTRACT_DUPLICATE_SOURCE_IDENTITY',
  );
  assert.throws(
    () => resolveLogicalContracts([a], classifications({
      'typescript:src/a.ts#A':{ significance:'projection', projection_of:'missing' },
    }), { allowedSemverKinds }),
    error => error?.code === 'CONTRACT_PROJECTION_TARGET_MISSING',
  );
  assert.throws(
    () => resolveLogicalContracts([a, b], classifications({
      'typescript:src/a.ts#A':{ logical_contract:'same', significance:'authority' },
      'typescript:src/b.ts#B':{ logical_contract:'same', significance:'authority' },
    }), { allowedSemverKinds }),
    error => error?.code === 'CONTRACT_MULTIPLE_AUTHORITIES',
  );
  assert.throws(
    () => resolveLogicalContracts([a], classifications({
      'typescript:src/missing.ts#Missing':{ logical_contract:'missing', significance:'authority' },
    }), { allowedSemverKinds }),
    error => error?.code === 'CONTRACT_CLASSIFICATION_SOURCE_MISSING',
  );
});

test('projection SemVer overrides and unknown SemVer kinds fail closed', () => {
  const a = candidate('typescript:src/a.ts#A');
  const p = candidate('mcp:mcp/a.js#inputSchema');
  assert.throws(
    () => resolveLogicalContracts([a, p], classifications({
      'typescript:src/a.ts#A':{ logical_contract:'a', significance:'public' },
      'mcp:mcp/a.js#inputSchema':{ significance:'projection', projection_of:'a', semver_kind:'semantic-command-contract' },
    }), { allowedSemverKinds }),
    error => error?.code === 'CONTRACT_PROJECTION_SEMVER_OVERRIDE',
  );
  assert.throws(
    () => resolveLogicalContracts([a], classifications({
      'typescript:src/a.ts#A':{ logical_contract:'a', significance:'public', semver_kind:'invented-kind' },
    }), { allowedSemverKinds }),
    error => error?.code === 'CONTRACT_SEMVER_KIND_UNKNOWN',
  );
});
