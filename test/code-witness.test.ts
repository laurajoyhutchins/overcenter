import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeCodeWitnesses,
  type CodeReferenceObservation,
  type ProductionSymbolObservation,
} from '../src/repository/code-witness.ts';

const revision = 'a'.repeat(40);

function symbol(
  path: string,
  name: string,
  overrides: Partial<ProductionSymbolObservation> = {},
): ProductionSymbolObservation {
  return {
    source_revision: revision,
    path,
    symbol: name,
    start_line: 1,
    kind: 'function',
    exported: false,
    top_level_reference: false,
    explicit_witnesses: [],
    ...overrides,
  };
}

function reference(
  from: ProductionSymbolObservation,
  to: ProductionSymbolObservation,
): CodeReferenceObservation {
  return {
    source_revision: revision,
    from: { path: from.path, symbol: from.symbol },
    to: { path: to.path, symbol: to.symbol },
  };
}

test('unreachable private symbol is reported as unwitnessed', () => {
  const orphan = symbol('src/orphan.ts', 'orphan');
  const report = analyzeCodeWitnesses({
    source_revision: revision,
    symbols: [orphan],
    references: [],
  });

  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ['UNWITNESSED_PRIVATE_SYMBOL'],
  );
  assert.equal(report.summary.unwitnessed_symbols, 1);
});

test('exported root witnesses its transitive private implementation', () => {
  const root = symbol('src/api.ts', 'run', { exported: true });
  const helper = symbol('src/api.ts', 'helper');
  const leaf = symbol('src/leaf.ts', 'leaf');
  const report = analyzeCodeWitnesses({
    source_revision: revision,
    symbols: [root, helper, leaf],
    references: [reference(root, helper), reference(helper, leaf)],
  });

  assert.equal(report.summary.root_symbols, 1);
  assert.equal(report.summary.reachable_symbols, 3);
  assert.deepEqual(report.findings, []);
});

test('dead private cycle remains unwitnessed', () => {
  const left = symbol('src/dead.ts', 'left');
  const right = symbol('src/dead.ts', 'right');
  const report = analyzeCodeWitnesses({
    source_revision: revision,
    symbols: [left, right],
    references: [reference(left, right), reference(right, left)],
  });

  assert.deepEqual(
    report.findings.map((finding) => finding.symbol),
    ['left', 'right'],
  );
});

test('architecture and TCB witnesses establish roots without source callers', () => {
  const authority = symbol('src/authority.ts', 'authority', {
    explicit_witnesses: [{ kind: 'architecture-intent', detail: 'src/authority.ts' }],
  });
  const verifier = symbol('src/verifier.ts', 'verify', {
    explicit_witnesses: [{ kind: 'tcb-symbol', detail: 'src/verifier.ts#verify' }],
  });
  const report = analyzeCodeWitnesses({
    source_revision: revision,
    symbols: [authority, verifier],
    references: [],
  });

  assert.equal(report.summary.root_symbols, 2);
  assert.deepEqual(report.findings, []);
});

test('reachable transparent wrapper with one caller is a simplification candidate', () => {
  const root = symbol('src/api.ts', 'run', { exported: true });
  const wrapper = symbol('src/api.ts', 'forward', {
    transparent_call_target: 'execute',
  });
  const report = analyzeCodeWitnesses({
    source_revision: revision,
    symbols: [root, wrapper],
    references: [reference(root, wrapper)],
  });

  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ['SINGLE_CALLER_TRANSPARENT_WRAPPER'],
  );
});

test('transparent wrapper with multiple reachable callers is retained', () => {
  const first = symbol('src/api.ts', 'first', { exported: true });
  const second = symbol('src/api.ts', 'second', { exported: true });
  const wrapper = symbol('src/api.ts', 'forward', {
    transparent_call_target: 'execute',
  });
  const report = analyzeCodeWitnesses({
    source_revision: revision,
    symbols: [first, second, wrapper],
    references: [reference(first, wrapper), reference(second, wrapper)],
  });

  assert.deepEqual(report.findings, []);
});

test('stale observations fail closed', () => {
  const stale = symbol('src/stale.ts', 'stale', {
    source_revision: 'b'.repeat(40),
  });
  assert.throws(
    () =>
      analyzeCodeWitnesses({
        source_revision: revision,
        symbols: [stale],
        references: [],
      }),
    /CODE_WITNESS_OBSERVATION_REVISION_MISMATCH/,
  );
});
