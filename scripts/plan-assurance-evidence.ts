import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { deriveInvalidatedEvidence } from '../src/architecture/change-planner.ts';
import {
  ARCHITECTURE_SQL_PATHS,
  loadArchitectureDatabase,
} from '../src/architecture/sql-model.ts';

const ARCHITECTURE_PATHS = new Set<string>(ARCHITECTURE_SQL_PATHS);

function emit(evidence: readonly string[], validationMode: string): void {
  process.stdout.write(`evidence_json=${JSON.stringify([...evidence].sort())}\n`);
  process.stdout.write(`validation_mode=${validationMode}\n`);
}

function gitText(revision: string, path: string): string {
  return execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
}

function packageAt(revision: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(gitText(revision, 'package.json'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function changedPaths(base: string, head: string): string[] {
  return execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACDMRT', base, head, '--'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .sort();
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

  const changed = changedPaths(base, head);
  const modelChanged = changed.some((path) => ARCHITECTURE_PATHS.has(path));
  const db = modelChanged
    ? loadArchitectureDatabase(process.cwd(), (path) => gitText(base, path))
    : loadArchitectureDatabase();

  try {
    emit(
      deriveInvalidatedEvidence(db, changed, {
        base_package: packageAt(base),
        head_package: packageAt(head),
      }).map((item) => item.evidence_id),
      modelChanged ? 'base-architecture' : 'current-architecture',
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
