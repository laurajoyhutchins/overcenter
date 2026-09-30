import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { ARCHITECTURE_SQL_PATHS } from '../src/architecture/sql-model.ts';
import type { AssurancePropertyImpact } from '../src/architecture/change-planner.ts';
import type { deriveAssuranceChangePlan } from '../src/architecture/change-planner.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import {
  planSourceTransaction,
  type TransactionAssurancePlan,
  type TrustedValidationPolicy,
} from '../src/source/transaction-planner.ts';

export interface SemanticChangePlan {
  base_revision: string;
  head_revision: string;
  changed_artifacts: string[];
  architecture_model_changed: boolean;
  impacts: AssurancePropertyImpact[];
  proof_plans: ReturnType<typeof deriveAssuranceChangePlan>[];
  assurance: TransactionAssurancePlan;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function revision(value: string): string {
  return git('rev-parse', `${value}^{commit}`);
}

export function semanticArtifactChanged(
  _path: string,
  before: string | null,
  after: string | null,
): boolean {
  return before !== after;
}

export function observeGitSemanticDelta(
  baseRevision: string,
  headRevision: string,
  repo = process.cwd(),
): string[] {
  return observeRepositoryDelta(repo, baseRevision, headRevision).entries.map(
    (entry) => entry.path,
  );
}

export type SemanticDeltaAdmission =
  | { state: 'ADMITTED'; changed_artifacts: string[] }
  | {
      state: 'REPLAN_REQUIRED';
      reason: 'SEMANTIC_TRANSACTION_DIVERGED';
      missing_artifacts: string[];
      unexpected_artifacts: string[];
    };

export function admitObservedSemanticDelta(
  expectedWriteSet: readonly string[],
  observedDelta: readonly string[],
): SemanticDeltaAdmission {
  const expected = [...new Set(expectedWriteSet)].sort();
  const observed = [...new Set(observedDelta)].sort();
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const missing = expected.filter((path) => !observedSet.has(path));
  const unexpected = observed.filter((path) => !expectedSet.has(path));

  if (missing.length > 0 || unexpected.length > 0) {
    return {
      state: 'REPLAN_REQUIRED',
      reason: 'SEMANTIC_TRANSACTION_DIVERGED',
      missing_artifacts: missing,
      unexpected_artifacts: unexpected,
    };
  }
  return { state: 'ADMITTED', changed_artifacts: observed };
}

export function planSemanticChange(
  baseRef: string,
  headRef = 'HEAD',
  policy: TrustedValidationPolicy = {
    baseline_id: null,
    baseline_sha256: null,
    validator_artifacts: [],
  },
): SemanticChangePlan {
  const baseRevision = revision(baseRef);
  const headRevision = revision(headRef);
  const delta = observeRepositoryDelta(process.cwd(), baseRevision, headRevision);
  const assurance = planSourceTransaction(process.cwd(), delta, policy);
  return {
    base_revision: baseRevision,
    head_revision: headRevision,
    changed_artifacts: assurance.changed_artifacts,
    architecture_model_changed: assurance.changed_artifacts.some((path) =>
      (ARCHITECTURE_SQL_PATHS as readonly string[]).includes(path),
    ),
    impacts: assurance.impacts,
    proof_plans: assurance.proof_plans,
    assurance,
  };
}

function main(): void {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) throw new Error('SEMANTIC_CHANGE_BASE_REQUIRED');
  process.stdout.write(`${JSON.stringify(planSemanticChange(base, head), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
