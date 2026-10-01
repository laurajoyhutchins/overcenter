import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { deriveAffectedAssuranceProperties } from '../src/architecture/change-planner.ts';
import { deriveAssuranceChangePlan } from '../src/authority/assurance-relations.ts';
import { ARCHITECTURE_SQL_PATHS, loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import { deriveRuntimeDispatchBindings, trustRootsForEffect } from '../src/architecture/tcb.ts';
import {
  reconcileArchitecture,
  type ObservedArchitecture,
} from '../src/architecture/reconciliation.ts';
import { observeArchitecture } from '../scripts/observe-architecture.ts';
import { semanticArtifactChanged } from '../scripts/plan-semantic-change.ts';
import { GOLDEN_TRANSACTION_CASE } from './fixtures/golden-transaction.ts';

const revision = 'a'.repeat(40);

function cloneObserved(observed: ObservedArchitecture): ObservedArchitecture {
  return structuredClone(observed);
}

let baselineObservation: ObservedArchitecture | null = null;

function observedArchitecture(): ObservedArchitecture {
  if (baselineObservation === null) {
    const db = loadArchitectureDatabase();
    try {
      baselineObservation = observeArchitecture(db, revision);
    } finally {
      db.close();
    }
  }
  return cloneObserved(baselineObservation);
}

test('architecture SQL separates language, logic, and physics', () => {
  assert.deepEqual(ARCHITECTURE_SQL_PATHS, [
    'architecture/concepts.sql',
    'architecture/logic.sql',
    'architecture/physics.sql',
  ]);

  const concepts = readFileSync('architecture/concepts.sql', 'utf8');
  const logic = readFileSync('architecture/logic.sql', 'utf8');
  const physics = readFileSync('architecture/physics.sql', 'utf8');
  const loader = readFileSync('src/architecture/sql-model.ts', 'utf8');

  assert.doesNotMatch(concepts, /src\/|\.github\/|github|kubernetes/i);
  assert.doesNotMatch(logic, /src\/|\.github\/workflows\//);
  assert.doesNotMatch(physics, /\bCREATE\s+TABLE\b/i);
  assert.doesNotMatch(loader, /\.read\b/);
});

test('layered architecture loads as one foreign-key-valid relational model', () => {
  const db = loadArchitectureDatabase();
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(
      Number(
        (
          db.prepare('SELECT COUNT(*) AS count FROM authority').get() as {
            count: number | bigint;
          }
        ).count,
      ),
      3,
    );
    assert.ok(
      Number(
        (
          db.prepare('SELECT COUNT(*) AS count FROM principal').get() as {
            count: number | bigint;
          }
        ).count,
      ) > 0,
    );
  } finally {
    db.close();
  }
});

test('TCB runtime dispatch authority comes from architecture physics', () => {
  const db = loadArchitectureDatabase();
  try {
    assert.deepEqual(deriveRuntimeDispatchBindings(db), [
      {
        target: {
          artifact_id: 'src/authority/store.ts',
          symbol_id: 'DurableFactStore.append',
        },
        implementation: {
          artifact_id: 'src/storage/sqlite.ts',
          symbol_id: 'SqliteFactStore.append',
        },
      },
      {
        target: {
          artifact_id: 'src/authority/store.ts',
          symbol_id: 'DurableFactStore.head',
        },
        implementation: {
          artifact_id: 'src/storage/sqlite.ts',
          symbol_id: 'SqliteFactStore.head',
        },
      },
      {
        target: {
          artifact_id: 'src/authority/store.ts',
          symbol_id: 'DurableFactStore.history',
        },
        implementation: {
          artifact_id: 'src/storage/sqlite.ts',
          symbol_id: 'SqliteFactStore.history',
        },
      },
    ]);

    const policy = JSON.parse(readFileSync('tcb-policy.json', 'utf8')) as {
      properties: Array<Record<string, unknown>>;
    };
    assert.equal(
      policy.properties.some(
        (property) =>
          'entries' in property ||
          'runtime_dispatch_bindings' in property ||
          'composes_with' in property ||
          'trusted_symbol_boundaries' in property,
      ),
      false,
    );
  } finally {
    db.close();
  }
});

test('TCB roots are derived recursively from effect architecture', () => {
  const db = loadArchitectureDatabase();
  try {
    const roots = trustRootsForEffect(db, 'github-commit-status/create');
    const identities = new Set(roots.map((root) => `${root.artifact_id}#${root.symbol_id}`));

    assert.ok(identities.has('src/authority/engine.ts#KernelCore.claim'));
    assert.ok(identities.has('src/authority/engine.ts#KernelCore.acquireExecution'));
    assert.ok(identities.has('src/authority/engine.ts#KernelCore.authorizeEffect'));
    assert.ok(identities.has('src/authority/engine.ts#KernelCore.beginEffect'));
    assert.ok(identities.has('src/authority/engine.ts#KernelCore.resolve'));
    assert.ok(identities.has('src/storage/sqlite.ts#SqliteFactStore.append'));
    assert.ok(identities.has('src/observation/observe.ts#observationVerified'));
    assert.ok(
      identities.has('src/providers/github/status-effect.ts#performGitHubCommitStatusEffect'),
    );

    const sourceRoots = trustRootsForEffect(db, 'source/integrate');
    assert.ok(
      sourceRoots.some(
        (root) =>
          root.artifact_id === 'src/source/source-integration.ts' &&
          root.symbol_id === 'integrateVerifiedSourceCandidate',
      ),
    );
  } finally {
    db.close();
  }
});

test('assurance proof plan is derived through existing property, effect, obligation, and evidence relations', () => {
  const db = loadArchitectureDatabase();
  try {
    const plan = deriveAssuranceChangePlan(db, 'github-commit-status-provider');

    assert.deepEqual(plan.properties, ['broker-mutation-safety', 'github-commit-status-provider']);
    assert.deepEqual(plan.effects, [
      'github-commit-status/create',
      'github-pull-request/update-branch',
      'kubernetes-configmap/ensure',
      'source/integrate',
    ]);
    assert.deepEqual(plan.obligations, [
      'authoritative-settlement',
      'exact-revision-effect',
      'reserve-before-effect',
      'unresolved-effect-no-replay',
    ]);
    assert.deepEqual(plan.evidence, [
      {
        evidence_id: 'effect-core-loop-proof',
        obligation_ids: [
          'exact-revision-effect',
          'reserve-before-effect',
          'unresolved-effect-no-replay',
        ],
        artifact_ids: ['test/trusted-effect-core-loop.test.ts'],
      },
      {
        evidence_id: 'provider-observation-proof',
        obligation_ids: ['authoritative-settlement'],
        artifact_ids: ['test/provider-observation.test.ts'],
      },
    ]);

    assert.ok(
      plan.realization_roots.some(
        (root) =>
          root.artifact_id === 'src/authority/engine.ts' &&
          root.symbol_id === 'KernelCore.authorizeEffect' &&
          root.basis === 'authority' &&
          root.requirement_id === 'effect-authority',
      ),
    );
    assert.ok(
      plan.realization_roots.some(
        (root) =>
          root.artifact_id === 'src/providers/github/status-effect.ts' &&
          root.symbol_id === 'performGitHubCommitStatusEffect' &&
          root.basis === 'effect' &&
          root.requirement_id === 'github-commit-status/create',
      ),
    );
  } finally {
    db.close();
  }
});

test('assurance proof planning fails closed when a required obligation has no witnessed evidence', () => {
  const db = loadArchitectureDatabase();
  try {
    db.prepare(
      "DELETE FROM evidence_witnesses_obligation WHERE obligation_id = 'authoritative-settlement'",
    ).run();

    assert.throws(
      () => deriveAssuranceChangePlan(db, 'github-commit-status-provider'),
      /ASSURANCE_SUPPORT_INCOMPLETE:obligation:authoritative-settlement/,
    );
  } finally {
    db.close();
  }
});

test('realization impact maps changed roots back to assurance properties and composition dependents', () => {
  const db = loadArchitectureDatabase();
  try {
    const impacts = deriveAffectedAssuranceProperties(
      db,
      ['src/providers/github/status-effect.ts'],
      (roots) => roots,
    );

    assert.deepEqual(impacts, [
      {
        property_id: 'authority-flow-integrity',
        changed_artifacts: ['src/providers/github/status-effect.ts'],
        direct: true,
        via_properties: [],
      },
      {
        property_id: 'distributed-authority-handoff-integrity',
        changed_artifacts: ['src/providers/github/status-effect.ts'],
        direct: true,
        via_properties: [],
      },
      {
        property_id: 'github-commit-status-provider',
        changed_artifacts: ['src/providers/github/status-effect.ts'],
        direct: true,
        via_properties: [],
      },
    ]);

    const authorityImpacts = deriveAffectedAssuranceProperties(
      db,
      ['src/authority/engine.ts'],
      (roots) => roots,
    );
    const broker = authorityImpacts.find(
      (impact) => impact.property_id === 'broker-mutation-safety',
    );
    const provider = authorityImpacts.find(
      (impact) => impact.property_id === 'github-commit-status-provider',
    );

    assert.equal(broker?.direct, true);
    assert.equal(provider?.direct, false);
    assert.deepEqual(provider?.via_properties, ['broker-mutation-safety']);
    assert.deepEqual(provider?.changed_artifacts, ['src/authority/engine.ts']);
  } finally {
    db.close();
  }
});

test('realization impact uses the supplied dependency closure rather than roots alone', () => {
  const db = loadArchitectureDatabase();
  try {
    const changedDependency = 'src/example-transitive-dependency.ts';
    const impacts = deriveAffectedAssuranceProperties(db, [changedDependency], (roots) =>
      roots.includes('src/providers/github/status-effect.ts')
        ? [...roots, changedDependency]
        : roots,
    );

    assert.deepEqual(impacts, [
      {
        property_id: 'github-commit-status-provider',
        changed_artifacts: [changedDependency],
        direct: true,
        via_properties: [],
      },
    ]);
  } finally {
    db.close();
  }
});

test('staged semantic delta conservatively retains changed TypeScript bytes', () => {
  assert.equal(
    semanticArtifactChanged(
      'src/example.ts',
      'export const value = 1;\n// old note\n',
      'export const value = 1;\n// new note\n',
    ),
    true,
  );
  assert.equal(
    semanticArtifactChanged(
      'src/example.ts',
      'export const value = 1;\n',
      'export const value = 2;\n',
    ),
    true,
  );
  assert.equal(
    semanticArtifactChanged('architecture/logic.sql', '-- old note\n', '-- new note\n'),
    true,
  );
  assert.equal(semanticArtifactChanged('src/example.ts', null, '// new file\n'), true);
});

test('golden transaction pins planner and lifecycle expectations', () => {
  const golden = GOLDEN_TRANSACTION_CASE;
  assert.deepEqual(golden.expected_write_set, [golden.candidate.path]);
  assert.equal(readFileSync(golden.candidate.path, 'utf8').includes(golden.candidate.before), true);

  const actualStagedDelta = semanticArtifactChanged(
    golden.candidate.path,
    golden.candidate.before,
    golden.candidate.after,
  )
    ? [golden.candidate.path]
    : [];
  assert.deepEqual(actualStagedDelta, golden.expected_staged_delta);

  const db = loadArchitectureDatabase();
  try {
    const impacts = deriveAffectedAssuranceProperties(db, actualStagedDelta, (roots) => roots);
    assert.deepEqual(impacts, golden.expected_assurance_impacts);

    const evidence = [
      ...new Map(
        impacts
          .flatMap((impact) => deriveAssuranceChangePlan(db, impact.property_id).evidence)
          .map((item) => [item.evidence_id, item]),
      ).values(),
    ].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
    assert.deepEqual(evidence, golden.expected_minimum_evidence);
  } finally {
    db.close();
  }
});

test('maintained relational architecture reconciles against the current repository', () => {
  const db = loadArchitectureDatabase();
  try {
    const observed = observedArchitecture();
    const reconciliation = reconcileArchitecture(db, observed);
    assert.deepEqual(reconciliation.findings, []);
  } finally {
    db.close();
  }
});

test('missing declared write capability is a SQL reconciliation finding', () => {
  const db = loadArchitectureDatabase();
  try {
    const observed = observedArchitecture();
    const principal =
      '.github/workflows/substrate-capability-admission-treatment.yml#foreign-ambient-status-write';
    observed.principal_capabilities = observed.principal_capabilities.filter(
      (row) =>
        !(
          row.principal_id === principal &&
          row.capability_id === 'github-actions/permission/statuses/write'
        ),
    );

    const reconciliation = reconcileArchitecture(db, observed);
    assert.ok(
      reconciliation.findings.some(
        (finding) =>
          finding.state === 'missing' &&
          finding.relation === 'principal_has_capability' &&
          finding.key.principal_id === principal &&
          finding.key.capability_id === 'github-actions/permission/statuses/write',
      ),
    );
  } finally {
    db.close();
  }
});

test('undeclared write capability is a SQL reconciliation finding', () => {
  const db = loadArchitectureDatabase();
  try {
    const observed = observedArchitecture();
    observed.principal_capabilities.push({
      principal_id: '.github/workflows/tests.yml#unit',
      capability_id: 'github-actions/permission/statuses/write',
    });

    const reconciliation = reconcileArchitecture(db, observed);
    assert.ok(
      reconciliation.findings.some(
        (finding) =>
          finding.state === 'unexpected' &&
          finding.relation === 'principal_has_capability' &&
          finding.key.principal_id === '.github/workflows/tests.yml#unit' &&
          finding.key.capability_id === 'github-actions/permission/statuses/write',
      ),
    );
  } finally {
    db.close();
  }
});

test('effect invocation and authority-bearing capability remain independent relations', () => {
  const db = loadArchitectureDatabase();
  try {
    const observed = observedArchitecture();
    const denied =
      '.github/workflows/substrate-capability-admission-treatment.yml#foreign-status-write-denied';
    const ambient =
      '.github/workflows/substrate-capability-admission-treatment.yml#foreign-ambient-status-write';

    assert.ok(
      observed.principal_invocations.some(
        (row) => row.principal_id === denied && row.effect_id === 'github-commit-status/create',
      ),
    );
    assert.equal(
      observed.principal_capabilities.some(
        (row) =>
          row.principal_id === denied &&
          row.capability_id === 'github-actions/permission/statuses/write',
      ),
      false,
    );
    assert.ok(
      observed.principal_capabilities.some(
        (row) =>
          row.principal_id === ambient &&
          row.capability_id === 'github-actions/permission/statuses/write',
      ),
    );
  } finally {
    db.close();
  }
});

test('missing physical symbol is detected without treating its declared semantics as observed', () => {
  const db = loadArchitectureDatabase();
  try {
    const observed = observedArchitecture();
    observed.symbols = observed.symbols.filter(
      (row) =>
        !(
          row.symbol_id === 'KernelCore.authorizeEffect' &&
          row.artifact_id === 'src/authority/engine.ts'
        ),
    );

    const reconciliation = reconcileArchitecture(db, observed);
    assert.ok(
      reconciliation.findings.some(
        (finding) =>
          finding.state === 'missing' &&
          finding.relation === 'symbol' &&
          finding.key.symbol_id === 'KernelCore.authorizeEffect' &&
          finding.key.artifact_id === 'src/authority/engine.ts',
      ),
    );
  } finally {
    db.close();
  }
});

test('logical authority without a physical implementation fails closed', () => {
  const db = loadArchitectureDatabase();
  try {
    db.prepare(
      "DELETE FROM symbol_implements_authority WHERE authority_id = 'effect-authority'",
    ).run();
    const observed = observedArchitecture();
    const reconciliation = reconcileArchitecture(db, observed);
    assert.ok(
      reconciliation.findings.some(
        (finding) =>
          finding.state === 'missing' &&
          finding.relation === 'authority_implementation' &&
          finding.key.authority_id === 'effect-authority',
      ),
    );
  } finally {
    db.close();
  }
});

test('unresolved dynamic effect reachability is unknown rather than silently accepted', () => {
  const db = loadArchitectureDatabase();
  try {
    const observed = observedArchitecture();
    observed.unresolved_effect_calls.push({
      principal_id: '.github/workflows/operator-project-submit.yml#command',
      call_site_path: 'src/example.ts',
      call_site_line: 17,
      call_expression_sha256: 'b'.repeat(64),
      candidate_effects: ['github-source/integrate-verified-tree/v1'],
    });

    const reconciliation = reconcileArchitecture(db, observed);
    assert.ok(
      reconciliation.findings.some(
        (finding) =>
          finding.state === 'unknown' &&
          finding.relation === 'principal_reaches_effect' &&
          finding.key.principal_id === '.github/workflows/operator-project-submit.yml#command',
      ),
    );
  } finally {
    db.close();
  }
});
