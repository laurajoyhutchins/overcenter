import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const deletedKernelReplacements = [
  'lib/compact-execution-state.js',
  'lib/compact-provider-operation-store.js',
  'lib/compact-proof-state-store.js',
  'lib/compact-github-changeset-receipt-store.js',
  'src/semantic/compact-execution-state.ts',
  'src/ports/compact-execution-state-store.ts',
  'src/adapters/postgres/compact-execution-state-store.ts',
  'type-tests/compact-execution-state.test.ts',
  'type-tests/compact-execution-state-store.test.ts',
  'scripts/compact-execution-state-postgres.test.mjs',
  'scripts/compact-production-promotion-proof-postgres.test.mjs',
  'scripts/compact-proof-adapter-postgres.test.mjs',
  'scripts/compact-proof-state-postgres.test.mjs',
  'scripts/compact-provider-operations-postgres.test.mjs',
  'scripts/compact-recovery-postgres.test.mjs',
  'scripts/verify-compact-execution-state-contracts.test.mjs',
  'scripts/verify-compact-state-migrations-postgres.test.mjs',
];

for (const relative of deletedKernelReplacements) {
  assert.equal(
    fs.existsSync(path.join(root, relative)),
    false,
    `superseded compact execution machinery remains: ${relative}`,
  );
}

const configurationFiles = [
  'tsconfig.semantic.runtime.json',
  'tsconfig.portable-runtime.json',
  'scripts/build.mjs',
  'scripts/test-integration.mjs',
];
const forbiddenConfiguration = /compact-(?:execution-state|provider-operation|proof-state)|compact-production-promotion-proof|compact-proof-adapter|compact-recovery-postgres|compact-provider-operations-postgres/;
for (const relative of configurationFiles) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.equal(
    forbiddenConfiguration.test(source),
    false,
    `superseded compact execution machinery remains wired in ${relative}`,
  );
}

const liveSourceFiles = [
  'lib/authoritative-state-cutover.js',
  'lib/deterministic-work-settlement.js',
  'lib/execution-evidence-store.js',
  'lib/orchestration-semantic-journal-resolution.js',
  'lib/orchestration-status.js',
  'lib/preview-snapshot.js',
  'lib/project-authoring-overcenter-host.js',
  'lib/project-inspect-github-runtime.js',
  'lib/portfolio-reconcile-execution-runtime.js',
  'lib/orchestration-maintenance-subjects.js',
  'lib/orchestration-runs.js',
  'lib/orchestration-recovery.js',
  'lib/project-transition-lease-store.js',
  'lib/project-transition-leases.js',
];
const forbiddenLiveSource = /github_(?:changeset|release|production_promotion)_receipts|portfolio_(?:reconcile|verification)_receipts|createCompact(?:ExecutionState|ProviderOperation|ProofState|GithubChangesetReceipt)Store|compact(?:ExecutionState|ProviderOperation|ProofState)|createProjectAuthoringRecoveryForRuntime|compactRecoveries|compact_operation|publicCompactExecution|compact_execution_state|compact_authority|compact execution authority|compactTransitionExecutionFingerprint|loadCompactContinuation/;
for (const relative of liveSourceFiles) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.equal(
    forbiddenLiveSource.test(source),
    false,
    `superseded provider/compact machinery remains live in ${relative}`,
  );
}

console.log('canonical execution-only boundary verified');
