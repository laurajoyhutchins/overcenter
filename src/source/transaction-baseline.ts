import { execFileSync } from 'node:child_process';
import { canonicalDigest } from '../digest.ts';
import { assertNonEmptyString, isPositiveSafeInteger } from '../validation.ts';
import { repositorySnapshot } from '../evidence/repository-snapshot.ts';
import type { RepositoryDelta } from './repository-delta.ts';
import type { TransactionAssurancePlan } from './transaction-planner.ts';

export interface SourceTransactionContext {
  repository_id: number;
  repository_full_name: string;
  runtime_sha: string;
  baseline_id: string;
  validator_paths: readonly string[];
}

export function validateSourceTransactionContext(context: SourceTransactionContext): void {
  if (
    !isPositiveSafeInteger(context.repository_id) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository_full_name) ||
    !/^[0-9a-f]{40}$/.test(context.runtime_sha)
  )
    throw new Error('SOURCE_TRANSACTION_CONTEXT_INVALID');
  assertNonEmptyString(context.baseline_id, 'SOURCE_TRANSACTION_BASELINE_INVALID');
  if (
    !context.validator_paths.length ||
    context.validator_paths.some(
      (path) =>
        !path ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').some((part) => ['.', '..', '.git'].includes(part) || !part),
    )
  )
    throw new Error('SOURCE_TRANSACTION_BASELINE_INVALID');
}

export function observeSourceBaseline(
  repo: string,
  revision: string,
  context: SourceTransactionContext,
) {
  validateSourceTransactionContext(context);
  const snapshot = repositorySnapshot(repo, revision);
  const files = execFileSync('git', ['-C', repo, 'ls-tree', '--name-only', '-r', '-z', revision])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const matched = files
    .filter((file) =>
      context.validator_paths.some((path) => file === path || file.startsWith(`${path}/`)),
    )
    .sort();
  for (const path of context.validator_paths)
    if (!matched.some((file) => file === path || file.startsWith(`${path}/`)))
      throw new Error(`SOURCE_TRANSACTION_BASELINE_UNAVAILABLE:${path}`);
  const artifacts = matched.map((path) => ({ path, blob: snapshot.blob(path) }));
  return {
    artifacts,
    digest: canonicalDigest({
      domain: 'overcenter-source-baseline/v1',
      id: context.baseline_id,
      artifacts,
    }),
  };
}

// Runtime admission deliberately uses the full declared baseline. The compiler planner remains
// a development tool; an uncaptured runtime dependency can never authorize skipping checks.
export function baselineSourceTransactionPlan(
  repo: string,
  delta: RepositoryDelta,
  context: SourceTransactionContext,
): TransactionAssurancePlan {
  const baseline = observeSourceBaseline(repo, delta.base_revision, context);
  const candidateBaseline = observeSourceBaseline(repo, delta.candidate_revision, context);
  const changed = delta.entries.map((entry) => entry.path);
  const source = repositorySnapshot(repo, delta.base_revision);
  const candidate = repositorySnapshot(repo, delta.candidate_revision);
  const models = ['architecture/schema.sql', 'architecture/logic.sql'].map((path) => ({
    path,
    base: source.optionalBytes(path)?.toString('base64') ?? null,
    candidate: candidate.optionalBytes(path)?.toString('base64') ?? null,
  }));
  const baselineChanged = baseline.digest !== candidateBaseline.digest;
  return {
    base_revision: delta.base_revision,
    candidate_revision: delta.candidate_revision,
    candidate_tree: delta.candidate_tree,
    model_sha256: canonicalDigest(models),
    dependency_sha256: canonicalDigest({
      domain: 'overcenter-whole-source-snapshots/v1',
      base_revision: delta.base_revision,
      candidate_revision: delta.candidate_revision,
      candidate_tree: delta.candidate_tree,
    }),
    changed_artifacts: changed,
    impacts: [],
    proof_plans: [],
    evidence: [],
    coverage_gaps: changed.map((artifact_id) => ({
      artifact_id,
      reason:
        baselineChanged &&
        context.validator_paths.some(
          (path) => artifact_id === path || artifact_id.startsWith(`${path}/`),
        )
          ? ('validator-changed' as const)
          : /\.(?:[cm]?ts|tsx)$/.test(artifact_id)
            ? ('unmodeled-artifact' as const)
            : ('unsupported-language' as const),
    })),
    validation_mode: baselineChanged ? 'unsupported' : 'baseline',
    baseline_id: context.baseline_id,
    baseline_sha256: baseline.digest,
  };
}

export function sourceTransactionContextFromEnvironment(): SourceTransactionContext {
  const name = process.env.OVERCENTER_COMMAND_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? '';
  const runtime =
    process.env.OVERCENTER_RUNTIME_SHA ?? process.env.OVERCENTER_COMMAND_SOURCE_SHA ?? '';
  const repository_id = Number(
    process.env.OVERCENTER_COMMAND_REPOSITORY_ID ?? process.env.GITHUB_REPOSITORY_ID,
  );
  const policy =
    name.toLowerCase() === 'laurajoyhutchins/overcenter-research'
      ? {
          baseline_id: 'overcenter-repository-checks/v1',
          validator_paths: [
            '.github/workflows',
            'test',
            'scripts',
            'formal',
            'package.json',
            'tsconfig.json',
            'biome.json',
            '.node-version',
            '.go-version',
          ],
        }
      : name.toLowerCase() === 'laurajoyhutchins/azelficoast'
        ? {
            baseline_id: 'azelficoast-repository-checks/v1',
            validator_paths: ['.github/workflows', 'pyproject.toml', 'uv.lock', 'tests'],
          }
        : null;
  if (!policy) throw new Error('SOURCE_TRANSACTION_REPOSITORY_POLICY_UNAVAILABLE');
  const context = { repository_id, repository_full_name: name, runtime_sha: runtime, ...policy };
  validateSourceTransactionContext(context);
  return context;
}
