import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export type HostedEvidenceKey =
  | 'authority-flow'
  | 'authority-storage'
  | 'distributed-handoff'
  | 'distributed-chaos'
  | 'substrate';

interface EvidenceSpec {
  exact: readonly string[];
  prefixes: readonly string[];
  ignored: readonly string[];
  packageScripts: readonly string[];
}

const RELATIONAL_PLANNER_PATHS = [
  'scripts/plan-assurance-evidence.ts',
  'src/architecture/change-planner.ts',
  'src/architecture/sql-model.ts',
  'src/source/transaction-planner.ts',
  'architecture/concepts.sql',
  'architecture/logic.sql',
  'architecture/physics.sql',
] as const;

const SPECS: Record<HostedEvidenceKey, EvidenceSpec> = {
  'authority-flow': {
    exact: [
      'scripts/plan-hosted-evidence.ts',
      ...RELATIONAL_PLANNER_PATHS,
      '.github/workflows/authority-flow-analysis.yml',
      'src/authority/engine.ts',
      'src/providers/github/status-effect.ts',
      'src/providers/github/pr-update-branch-effect.ts',
    ],
    prefixes: ['experiments/authority-flow-analysis/'],
    ignored: ['experiments/authority-flow-analysis/README.md'],
    packageScripts: ['typecheck', 'test:authority-flow-analysis'],
  },
  'authority-storage': {
    exact: [
      'scripts/plan-hosted-evidence.ts',
      ...RELATIONAL_PLANNER_PATHS,
      '.github/workflows/authority-storage-decomposition.yml',
      'src/storage/git-store.ts',
      'src/storage/git-kernel.ts',
    ],
    prefixes: ['experiments/authority-storage-decomposition/', 'src/authority/'],
    ignored: ['experiments/authority-storage-decomposition/README.md'],
    packageScripts: ['test:authority-storage-decomposition'],
  },
  'distributed-handoff': {
    exact: [
      'scripts/plan-hosted-evidence.ts',
      ...RELATIONAL_PLANNER_PATHS,
      '.github/workflows/distributed-authority-handoff.yml',
      'src/storage/git-kernel.ts',
      'src/storage/git-store.ts',
      'src/providers/github/status-effect.ts',
    ],
    prefixes: ['experiments/distributed-authority-handoff/', 'src/authority/'],
    ignored: ['experiments/distributed-authority-handoff/README.md'],
    packageScripts: ['test:distributed-authority-handoff'],
  },
  'distributed-chaos': {
    exact: [
      'scripts/plan-hosted-evidence.ts',
      ...RELATIONAL_PLANNER_PATHS,
      '.github/workflows/distributed-authority-chaos.yml',
      'src/storage/git-kernel.ts',
      'src/storage/git-store.ts',
    ],
    prefixes: ['experiments/distributed-authority-chaos/', 'src/authority/'],
    ignored: ['experiments/distributed-authority-chaos/README.md'],
    packageScripts: ['test:distributed-authority-chaos'],
  },
  substrate: {
    exact: [
      'scripts/plan-hosted-evidence.ts',
      ...RELATIONAL_PLANNER_PATHS,
      '.github/workflows/substrate-capability-admission.yml',
      '.github/workflows/substrate-capability-admission-treatment.yml',
    ],
    prefixes: ['experiments/substrate-capability-admission/', 'src/execution/confinement/'],
    ignored: [
      'experiments/substrate-capability-admission/README.md',
      'src/execution/confinement/README.md',
    ],
    packageScripts: ['test:substrate-capability-admission', 'proof:rust-exec'],
  },
};

const PACKAGE_RUNTIME_KEYS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'engines',
  'packageManager',
  'type',
]);

const PACKAGE_METADATA_KEYS = new Set(['name', 'private', 'version', 'description', 'license']);

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !isDeepStrictEqual(before[key], after[key]))
    .sort();
}

function packageRequiresEvidence(
  spec: EvidenceSpec,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const topLevel = changedKeys(before, after);
  if (topLevel.some((key) => PACKAGE_RUNTIME_KEYS.has(key))) return true;

  const unknown = topLevel.filter((key) => key !== 'scripts' && !PACKAGE_METADATA_KEYS.has(key));
  if (unknown.length > 0) return true;
  if (!topLevel.includes('scripts')) return false;

  const beforeScripts = objectValue(before.scripts);
  const afterScripts = objectValue(after.scripts);
  if (!beforeScripts || !afterScripts) return true;

  const relevant = new Set(spec.packageScripts);
  return changedKeys(beforeScripts, afterScripts).some((key) => relevant.has(key));
}

export interface HostedEvidencePlan {
  required: boolean;
  reason: 'matching-path' | 'package-runtime' | 'irrelevant-package' | 'no-impact';
}

export function planHostedEvidence(
  key: HostedEvidenceKey,
  changedPaths: readonly string[],
  basePackage?: Record<string, unknown>,
  headPackage?: Record<string, unknown>,
): HostedEvidencePlan {
  const spec = SPECS[key];
  const ignored = new Set(spec.ignored);

  for (const path of changedPaths) {
    if (ignored.has(path) || path === 'package.json') continue;
    if (spec.exact.includes(path) || spec.prefixes.some((prefix) => path.startsWith(prefix))) {
      return { required: true, reason: 'matching-path' };
    }
  }

  if (changedPaths.includes('package.json')) {
    if (!basePackage || !headPackage) {
      return { required: true, reason: 'package-runtime' };
    }
    if (packageRequiresEvidence(spec, basePackage, headPackage)) {
      return { required: true, reason: 'package-runtime' };
    }
    return { required: false, reason: 'irrelevant-package' };
  }

  return { required: false, reason: 'no-impact' };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function packageAt(revision: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(git('show', `${revision}:package.json`));
  const value = objectValue(parsed);
  if (!value) throw new Error('HOSTED_EVIDENCE_PACKAGE_INVALID');
  return value;
}

function isHostedEvidenceKey(value: string): value is HostedEvidenceKey {
  return Object.hasOwn(SPECS, value);
}

function emit(required: boolean, reason: string): void {
  process.stdout.write(`required=${required ? 'true' : 'false'}\nreason=${reason}\n`);
}

function main(): void {
  const [key, base, head] = process.argv.slice(2);
  if (!key || !isHostedEvidenceKey(key)) throw new Error('HOSTED_EVIDENCE_KEY_INVALID');

  if (!base || !head) {
    emit(true, 'unbounded-revision');
    return;
  }

  const changedPaths = git('diff', '--name-only', '--diff-filter=ACDMRT', base, head)
    .split('\n')
    .filter(Boolean);

  const hasPackage = changedPaths.includes('package.json');
  const plan = planHostedEvidence(
    key,
    changedPaths,
    hasPackage ? packageAt(base) : undefined,
    hasPackage ? packageAt(head) : undefined,
  );
  emit(plan.required, plan.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
