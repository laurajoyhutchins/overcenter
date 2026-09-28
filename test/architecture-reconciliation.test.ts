import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ARCHITECTURE_SQL_PATHS, loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import { deriveRuntimeDispatchBindings, trustRootsForEffect } from '../src/architecture/tcb.ts';
import {
  reconcileArchitecture,
  type ObservedArchitecture,
} from '../src/architecture/reconciliation.ts';
import { observeArchitecture } from '../scripts/observe-architecture.ts';

const revision = 'a'.repeat(40);

function cloneObserved(observed: ObservedArchitecture): ObservedArchitecture {
  return structuredClone(observed);
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

test('maintained relational architecture reconciles against the current repository', () => {
  const db = loadArchitectureDatabase();
  try {
    const observed = observeArchitecture(db, revision);
    const reconciliation = reconcileArchitecture(db, observed);
    assert.deepEqual(reconciliation.findings, []);
  } finally {
    db.close();
  }
});

test('missing declared write capability is a SQL reconciliation finding', () => {
  const db = loadArchitectureDatabase();
  try {
    const observed = cloneObserved(observeArchitecture(db, revision));
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
    const observed = cloneObserved(observeArchitecture(db, revision));
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
    const observed = observeArchitecture(db, revision);
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
    const observed = cloneObserved(observeArchitecture(db, revision));
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
    const observed = observeArchitecture(db, revision);
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
    const observed = cloneObserved(observeArchitecture(db, revision));
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
