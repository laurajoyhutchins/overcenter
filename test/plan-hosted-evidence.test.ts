import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { deriveInvalidatedEvidence } from '../src/architecture/change-planner.ts';
import { loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import { planHostedEvidence, type HostedEvidenceKey } from '../scripts/plan-hosted-evidence.ts';

const LEGACY_KEYS: HostedEvidenceKey[] = [
  'authority-flow',
  'authority-storage',
  'distributed-handoff',
  'distributed-chaos',
  'substrate',
];

const EVIDENCE_BY_LEGACY_KEY: Record<HostedEvidenceKey, string> = {
  'authority-flow': 'authority-flow-proof',
  'authority-storage': 'authority-storage-proof',
  'distributed-handoff': 'distributed-authority-handoff-proof',
  'distributed-chaos': 'distributed-authority-chaos-proof',
  substrate: 'substrate-capability-admission-proof',
};

const HOSTED_EVIDENCE = new Set(Object.values(EVIDENCE_BY_LEGACY_KEY));
const ALL_HOSTED = [...HOSTED_EVIDENCE].sort();

function legacySet(
  changedPaths: readonly string[],
  basePackage?: Record<string, unknown>,
  headPackage?: Record<string, unknown>,
): string[] {
  return LEGACY_KEYS.filter(
    (key) => planHostedEvidence(key, changedPaths, basePackage, headPackage).required,
  )
    .map((key) => EVIDENCE_BY_LEGACY_KEY[key])
    .sort();
}

function relationalSet(
  changedPaths: readonly string[],
  basePackage?: Record<string, unknown>,
  headPackage?: Record<string, unknown>,
): string[] {
  const db = loadArchitectureDatabase();
  try {
    return deriveInvalidatedEvidence(db, changedPaths, {
      base_package: basePackage,
      head_package: headPackage,
    })
      .map((item) => item.evidence_id)
      .filter((evidenceId) => HOSTED_EVIDENCE.has(evidenceId))
      .sort();
  } finally {
    db.close();
  }
}

test('legacy and relational hosted evidence planners agree for every tracked artifact', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .sort();

  for (const path of tracked) {
    assert.deepEqual(relationalSet([path]), legacySet([path]), path);
  }
});

test('path hostile matrix compares complete proof sets rather than booleans', () => {
  const cases: Array<{ name: string; paths: string[]; expected: string[] }> = [
    {
      name: 'implementation file changed',
      paths: ['src/authority/engine.ts'],
      expected: [
        'authority-flow-proof',
        'authority-storage-proof',
        'distributed-authority-chaos-proof',
        'distributed-authority-handoff-proof',
      ],
    },
    {
      name: 'implementation file deleted',
      paths: ['src/storage/git-store.ts'],
      expected: [
        'authority-storage-proof',
        'distributed-authority-chaos-proof',
        'distributed-authority-handoff-proof',
      ],
    },
    {
      name: 'proof implementation changed',
      paths: ['experiments/authority-flow-analysis/analyzer.ts'],
      expected: ['authority-flow-proof'],
    },
    {
      name: 'proof workflow changed',
      paths: ['.github/workflows/distributed-authority-chaos.yml'],
      expected: ['distributed-authority-chaos-proof'],
    },
    {
      name: 'README only',
      paths: ['experiments/distributed-authority-chaos/README.md'],
      expected: [],
    },
    {
      name: 'multiple independent changes',
      paths: [
        'experiments/authority-flow-analysis/analyzer.ts',
        'src/execution/confinement/main.rs',
      ],
      expected: ['authority-flow-proof', 'substrate-capability-admission-proof'],
    },
    {
      name: 'deletion plus replacement',
      paths: [
        'experiments/distributed-authority-handoff/controller.ts',
        'src/providers/github/status-effect.ts',
      ],
      expected: ['authority-flow-proof', 'distributed-authority-handoff-proof'],
    },
    {
      name: 'architecture SQL changed',
      paths: ['architecture/logic.sql'],
      expected: ALL_HOSTED,
    },
    {
      name: 'one implementation affects several proofs',
      paths: ['src/authority/delegation.ts'],
      expected: [
        'authority-storage-proof',
        'distributed-authority-chaos-proof',
        'distributed-authority-handoff-proof',
      ],
    },
  ];

  for (const fixture of cases) {
    const legacy = legacySet(fixture.paths);
    const relational = relationalSet(fixture.paths);
    assert.deepEqual(legacy, fixture.expected, fixture.name + ': legacy');
    assert.deepEqual(relational, fixture.expected, fixture.name + ': relational');
  }
});

test('package perturbation matrix preserves conservative fail-closed semantics', () => {
  const before = {
    name: 'overcenter',
    private: true,
    type: 'module',
    description: 'before',
    scripts: {
      typecheck: 'tsc -p tsconfig.json',
      'test:authority-flow-analysis': 'node flow.ts',
      'test:authority-storage-decomposition': 'node storage.ts',
      'test:distributed-authority-handoff': 'node handoff.ts',
      'test:distributed-authority-chaos': 'node chaos.ts',
      'test:substrate-capability-admission': 'node substrate.ts',
      'proof:rust-exec': 'bash proof.sh',
      'test:unit': 'node unit.ts',
    },
    devDependencies: { typescript: '7.0.2' },
  };

  const cases: Array<{
    name: string;
    after: Record<string, unknown>;
    expected: string[];
  }> = [
    {
      name: 'dependencies',
      after: { ...before, dependencies: { example: '1.0.0' } },
      expected: ALL_HOSTED,
    },
    {
      name: 'devDependencies',
      after: { ...before, devDependencies: { typescript: '7.0.3' } },
      expected: ALL_HOSTED,
    },
    {
      name: 'runtime metadata',
      after: { ...before, type: 'commonjs' },
      expected: ALL_HOSTED,
    },
    {
      name: 'relevant script',
      after: {
        ...before,
        scripts: { ...before.scripts, 'test:distributed-authority-chaos': 'node newer.ts' },
      },
      expected: ['distributed-authority-chaos-proof'],
    },
    {
      name: 'unrelated script',
      after: {
        ...before,
        scripts: { ...before.scripts, 'test:unit': 'node newer-unit.ts' },
      },
      expected: [],
    },
    {
      name: 'unknown top-level semantic field',
      after: { ...before, customRuntimePolicy: 'strict' },
      expected: ALL_HOSTED,
    },
    {
      name: 'ordinary package metadata',
      after: { ...before, description: 'after' },
      expected: [],
    },
  ];

  for (const fixture of cases) {
    const legacy = legacySet(['package.json'], before, fixture.after);
    const relational = relationalSet(['package.json'], before, fixture.after);
    assert.deepEqual(legacy, fixture.expected, fixture.name + ': legacy');
    assert.deepEqual(relational, fixture.expected, fixture.name + ': relational');
  }
});

test('missing package snapshots fail closed for every hosted proof', () => {
  assert.deepEqual(legacySet(['package.json']), ALL_HOSTED);
  assert.deepEqual(relationalSet(['package.json']), ALL_HOSTED);
});
