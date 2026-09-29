import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { API } from 'typescript/unstable/sync';

import {
  deriveAffectedAssuranceProperties,
  deriveAssuranceChangePlan,
  type AssurancePropertyImpact,
} from '../src/architecture/change-planner.ts';
import { ARCHITECTURE_SQL_PATHS, loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import { deriveAssurancePropertyTrustRoots } from '../src/architecture/tcb.ts';
import { runtimeModuleClosure } from '../src/analysis/typescript-runtime.ts';

export interface SemanticChangePlan {
  base_revision: string;
  head_revision: string;
  changed_artifacts: string[];
  architecture_model_changed: boolean;
  impacts: AssurancePropertyImpact[];
  proof_plans: ReturnType<typeof deriveAssuranceChangePlan>[];
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function revision(value: string): string {
  return git('rev-parse', `${value}^{commit}`);
}

function gitFile(revisionValue: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${revisionValue}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function typeScriptSemanticText(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('//') &&
        !line.startsWith('/*') &&
        !line.startsWith('*') &&
        !line.startsWith('*/'),
    )
    .join('\n');
}

export function semanticArtifactChanged(
  path: string,
  before: string | null,
  after: string | null,
): boolean {
  if (before === null || after === null) return before !== after;
  if (/\.(?:[cm]?ts|tsx)$/.test(path)) {
    return typeScriptSemanticText(before) !== typeScriptSemanticText(after);
  }
  return before !== after;
}

export function observeGitSemanticDelta(baseRevision: string, headRevision: string): string[] {
  const output = git(
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=ACDMRT',
    baseRevision,
    headRevision,
  );
  if (!output) return [];

  return output
    .split('\n')
    .filter(Boolean)
    .filter((path) =>
      semanticArtifactChanged(path, gitFile(baseRevision, path), gitFile(headRevision, path)),
    )
    .sort();
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

function allAssuranceProperties(db: ReturnType<typeof loadArchitectureDatabase>): string[] {
  return (
    db
      .prepare('SELECT property_id FROM assurance_property ORDER BY property_id')
      .all() as unknown as Array<{ property_id: string }>
  ).map((row) => row.property_id);
}

export function planSemanticChange(baseRef: string, headRef = 'HEAD'): SemanticChangePlan {
  const baseRevision = revision(baseRef);
  const headRevision = revision(headRef);
  const checkedOutRevision = revision('HEAD');
  if (headRevision !== checkedOutRevision) {
    throw new Error(`SEMANTIC_CHANGE_HEAD_NOT_CHECKED_OUT:${headRevision}:${checkedOutRevision}`);
  }

  const changedArtifacts = observeGitSemanticDelta(baseRevision, headRevision);
  const architectureModelChanged = changedArtifacts.some((path) =>
    ARCHITECTURE_SQL_PATHS.includes(path as (typeof ARCHITECTURE_SQL_PATHS)[number]),
  );
  const db = loadArchitectureDatabase();
  const api = new API({ cwd: process.cwd() });

  try {
    const roots = deriveAssurancePropertyTrustRoots(db);
    const openFiles = [
      ...new Set(
        roots
          .map((root) => root.artifact_id)
          .filter((path) => /\.(?:[cm]?ts|tsx)$/.test(path))
          .map((path) => resolve(path)),
      ),
    ];
    const snapshot = api.updateSnapshot({ openFiles });

    try {
      const dependencyClosure = (rootArtifacts: readonly string[]): readonly string[] => {
        const typeScriptRoots = rootArtifacts.filter((path) => /\.(?:[cm]?ts|tsx)$/.test(path));
        const otherRoots = rootArtifacts.filter((path) => !/\.(?:[cm]?ts|tsx)$/.test(path));
        if (typeScriptRoots.length === 0) return [...otherRoots].sort();

        const closure = runtimeModuleClosure(process.cwd(), typeScriptRoots, (path) => {
          const absolute = resolve(path);
          return (
            snapshot.getDefaultProjectForFile(absolute)?.program.getSourceFile(absolute) ?? null
          );
        });
        return [...new Set([...otherRoots, ...closure.files])].sort();
      };

      const impacts = architectureModelChanged
        ? allAssuranceProperties(db).map(
            (property_id): AssurancePropertyImpact => ({
              property_id,
              changed_artifacts: [...changedArtifacts],
              direct: true,
              via_properties: [],
            }),
          )
        : deriveAffectedAssuranceProperties(db, changedArtifacts, dependencyClosure);

      return {
        base_revision: baseRevision,
        head_revision: headRevision,
        changed_artifacts: changedArtifacts,
        architecture_model_changed: architectureModelChanged,
        impacts,
        proof_plans: impacts.map((impact) => deriveAssuranceChangePlan(db, impact.property_id)),
      };
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
    db.close();
  }
}

function main(): void {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) throw new Error('SEMANTIC_CHANGE_BASE_REQUIRED');
  process.stdout.write(`${JSON.stringify(planSemanticChange(base, head), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
