import { ARCHITECTURE_SQL_PATHS } from '../architecture/sql-model.ts';
import { execFileSync } from 'node:child_process';
import { canonicalDigest } from '../digest.ts';
import { isPositiveSafeInteger } from '../validation.ts';
import { repositorySnapshot } from '../evidence/repository-snapshot.ts';
import type { RepositoryDelta } from './repository-delta.ts';
import type { TransactionAssurancePlan } from './transaction-planner.ts';
import {
  sourceVerificationRecipeStep,
  type SourceVerificationProfile,
} from './source-verification-profile.ts';

export interface SourceTransactionContext {
  repository_id: number;
  repository_full_name: string;
  runtime_sha: string;
}

export function validateSourceTransactionContext(context: SourceTransactionContext): void {
  if (
    !isPositiveSafeInteger(context.repository_id) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository_full_name) ||
    !/^[0-9a-f]{40}$/.test(context.runtime_sha)
  )
    throw new Error('SOURCE_TRANSACTION_CONTEXT_INVALID');
}

export function observeSourceBaseline(
  repo: string,
  revision: string,
  profile: SourceVerificationProfile,
) {
  const snapshot = repositorySnapshot(repo, revision);
  const raw = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', revision]);
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw new Error('SOURCE_TRANSACTION_BASELINE_PATH_ENCODING');
  const entries = text
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\t');
      const header = entry.slice(0, separator).split(' ');
      if (separator < 0 || header.length !== 3)
        throw new Error('SOURCE_TRANSACTION_BASELINE_TREE_INVALID');
      return { path: entry.slice(separator + 1), mode: header[0]! };
    });
  const files = entries.map((entry) => entry.path);
  const matched = files
    .filter((file) =>
      profile.protected_paths.some((path) => file === path || file.startsWith(`${path}/`)),
    )
    .sort();
  for (const path of profile.protected_paths)
    if (!matched.some((file) => file === path || file.startsWith(`${path}/`)))
      throw new Error(`SOURCE_TRANSACTION_BASELINE_UNAVAILABLE:${path}`);
  const artifacts = matched.map((path) => ({
    path,
    mode: entries.find((entry) => entry.path === path)!.mode,
    blob: snapshot.blob(path),
  }));
  return {
    artifacts,
    digest: canonicalDigest({
      domain: 'overcenter-source-baseline/v1',
      id: profile.id,
      artifacts,
    }),
  };
}

// Runtime admission deliberately uses the full declared baseline. The compiler planner remains
// a development tool; an uncaptured runtime dependency can never authorize skipping checks.
export function baselineSourceTransactionPlan(
  repo: string,
  delta: RepositoryDelta,
  profile: SourceVerificationProfile,
): TransactionAssurancePlan {
  const baseline = observeSourceBaseline(repo, delta.base_revision, profile);
  const candidateBaseline = observeSourceBaseline(repo, delta.candidate_revision, profile);
  const changed = delta.entries.map((entry) => entry.path);
  const source = repositorySnapshot(repo, delta.base_revision);
  const candidate = repositorySnapshot(repo, delta.candidate_revision);
  const models = ARCHITECTURE_SQL_PATHS.map((path) => ({
    path,
    base: source.optionalBytes(path)?.toString('base64') ?? null,
    candidate: candidate.optionalBytes(path)?.toString('base64') ?? null,
  }));
  const baselineChanged = baseline.digest !== candidateBaseline.digest;
  const modelChanged = changed.some((path) =>
    (ARCHITECTURE_SQL_PATHS as readonly string[]).includes(path),
  );
  const modelSha256 = canonicalDigest(models);
  const dependencySha256 = canonicalDigest({
    domain: 'overcenter-whole-source-snapshots/v1',
    base_revision: delta.base_revision,
    candidate_revision: delta.candidate_revision,
    candidate_tree: delta.candidate_tree,
  });
  const recipeSteps = profile.commands.map(sourceVerificationRecipeStep);
  return {
    base_revision: delta.base_revision,
    candidate_revision: delta.candidate_revision,
    candidate_tree: delta.candidate_tree,
    model_sha256: modelSha256,
    dependency_sha256: dependencySha256,
    changed_artifacts: changed,
    impacts: [],
    proof_plans: [],
    evidence: [],
    evidence_frontiers: [
      {
        coordinate: `revision:${delta.candidate_revision}`,
        revision: delta.candidate_revision,
        model_sha256: modelSha256,
        dependency_sha256: dependencySha256,
        baseline_sha256: baseline.digest,
        required_propositions: [`baseline:${profile.id}`],
        candidates: [
          {
            evidence_id: `baseline:${profile.id}`,
            proposition_ids: [`baseline:${profile.id}`],
            obligation_ids: [],
            artifact_ids: [],
            package_scripts: [...recipeSteps].sort(),
            uses_package_runtime: recipeSteps.some((step) => !step.startsWith('argv:')),
          },
        ],
      },
    ],
    coverage_gaps: changed.map((artifact_id) => ({
      artifact_id,
      reason: (ARCHITECTURE_SQL_PATHS as readonly string[]).includes(artifact_id)
        ? ('model-changed' as const)
        : baselineChanged &&
            profile.protected_paths.some(
              (path) => artifact_id === path || artifact_id.startsWith(`${path}/`),
            )
          ? ('validator-changed' as const)
          : /\.(?:[cm]?ts|tsx)$/.test(artifact_id)
            ? ('unmodeled-artifact' as const)
            : ('unsupported-language' as const),
    })),
    validation_mode: baselineChanged || modelChanged ? 'unsupported' : 'baseline',
    baseline_id: profile.id,
    baseline_sha256: baseline.digest,
  };
}

export function sourceTransactionContextFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SourceTransactionContext {
  const name = env.OVERCENTER_COMMAND_REPOSITORY ?? env.GITHUB_REPOSITORY ?? '';
  const runtime = env.OVERCENTER_RUNTIME_SHA ?? env.OVERCENTER_COMMAND_SOURCE_SHA ?? '';
  const repository_id = Number(env.OVERCENTER_COMMAND_REPOSITORY_ID ?? env.GITHUB_REPOSITORY_ID);
  const context = { repository_id, repository_full_name: name, runtime_sha: runtime };
  validateSourceTransactionContext(context);
  return context;
}
