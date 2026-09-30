import { pathToFileURL } from 'node:url';

import { loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import { planSourceTransaction } from '../src/source/transaction-planner.ts';

function emit(evidence: readonly string[], validationMode: string): void {
  process.stdout.write(`evidence_json=${JSON.stringify([...evidence].sort())}\n`);
  process.stdout.write(`validation_mode=${validationMode}\n`);
}

function allHostedEvidence(): string[] {
  const db = loadArchitectureDatabase();
  try {
    return (
      db
        .prepare('SELECT evidence_id FROM evidence_uses_package_runtime ORDER BY evidence_id')
        .all() as unknown as Array<{ evidence_id: string }>
    ).map((row) => row.evidence_id);
  } finally {
    db.close();
  }
}

function main(): void {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    emit(allHostedEvidence(), 'unbounded-revision');
    return;
  }

  const delta = observeRepositoryDelta(process.cwd(), base, head);
  const plan = planSourceTransaction(process.cwd(), delta, {
    baseline_id: 'hosted-evidence-planning',
    baseline_sha256: '0'.repeat(64),
    validator_artifacts: [],
  });
  emit(
    plan.evidence.map((item) => item.evidence_id),
    plan.validation_mode,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
