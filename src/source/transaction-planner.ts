import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { API } from 'typescript/unstable/sync';

import { runtimeModuleClosure } from '../analysis/typescript-runtime.ts';
import {
  deriveAffectedAssuranceProperties,
  type AssurancePropertyImpact,
} from '../architecture/change-planner.ts';
import {
  deriveAssuranceChangePlan,
  type AssuranceChangePlan,
} from '../authority/assurance-relations.ts';
import { ARCHITECTURE_SQL_PATHS, loadArchitectureDatabase } from '../architecture/sql-model.ts';
import { deriveAssurancePropertyTrustRoots } from '../architecture/tcb.ts';
import { canonicalDigest } from '../digest.ts';
import { repositorySnapshot } from '../evidence/repository-snapshot.ts';
import {
  assertSupportedSourceDelta,
  observeRepositoryDelta,
  type RepositoryDelta,
} from './repository-delta.ts';

export interface TrustedValidationPolicy {
  baseline_id: string | null;
  baseline_sha256: string | null;
  validator_artifacts: readonly string[];
}

export interface TransactionCoverageGap {
  artifact_id: string;
  reason:
    | 'unmodeled-artifact'
    | 'unsupported-language'
    | 'unresolved-dependency'
    | 'source-unavailable'
    | 'evidence-unmapped'
    | 'model-changed'
    | 'validator-changed';
}

export interface TransactionAssurancePlan {
  base_revision: string;
  candidate_revision: string;
  candidate_tree: string;
  model_sha256: string;
  dependency_sha256: string;
  changed_artifacts: string[];
  impacts: AssurancePropertyImpact[];
  proof_plans: AssuranceChangePlan[];
  evidence: AssuranceChangePlan['evidence'];
  coverage_gaps: TransactionCoverageGap[];
  validation_mode: 'selective' | 'baseline' | 'unsupported';
  baseline_id: string | null;
  baseline_sha256: string | null;
}

function snapshotDirectory(repo: string, sha: string) {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-transaction-snapshot-'));
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', root, sha], { stdio: 'pipe' });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    close: () => {
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', root], { stdio: 'pipe' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

export function planSourceTransaction(
  repo: string,
  suppliedDelta: RepositoryDelta,
  policy: TrustedValidationPolicy,
): TransactionAssurancePlan {
  const delta = observeRepositoryDelta(
    repo,
    suppliedDelta.base_revision,
    suppliedDelta.candidate_revision,
  );
  if (canonicalDigest(delta) !== canonicalDigest(suppliedDelta))
    throw new Error('SOURCE_TRANSACTION_DELTA_MISMATCH');
  assertSupportedSourceDelta(delta);
  if (
    (policy.baseline_id === null) !== (policy.baseline_sha256 === null) ||
    (policy.baseline_sha256 !== null && !/^[0-9a-f]{64}$/.test(policy.baseline_sha256))
  )
    throw new Error('SOURCE_TRANSACTION_BASELINE_INVALID');
  const changed = delta.entries.map((entry) => entry.path);
  const packageSnapshots = [delta.base_revision, delta.candidate_revision].map((sha) => {
    const bytes = repositorySnapshot(repo, sha).optionalBytes('package.json');
    if (!bytes) return undefined;
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      return value as Record<string, unknown>;
    } catch {
      return undefined;
    }
  });
  const gaps: TransactionCoverageGap[] = [];
  const addGap = (artifact_id: string, reason: TransactionCoverageGap['reason']): void => {
    gaps.push({ artifact_id, reason });
  };
  const models = [delta.base_revision, delta.candidate_revision].map((sha) => {
    const snapshot = repositorySnapshot(repo, sha);
    return ARCHITECTURE_SQL_PATHS.map((path) => ({
      path,
      bytes: snapshot.optionalBytes(path)?.toString('base64') ?? null,
    }));
  });
  const modelChanged = changed.some((path) =>
    (ARCHITECTURE_SQL_PATHS as readonly string[]).includes(path),
  );
  for (const path of changed) {
    if (
      !/\.(?:[cm]?ts|tsx)$/.test(path) &&
      !(ARCHITECTURE_SQL_PATHS as readonly string[]).includes(path)
    )
      addGap(path, 'unsupported-language');
    if (policy.validator_artifacts.includes(path)) addGap(path, 'validator-changed');
    if ((ARCHITECTURE_SQL_PATHS as readonly string[]).includes(path)) addGap(path, 'model-changed');
  }

  const impactMap = new Map<string, AssurancePropertyImpact>();
  const proofs = new Map<string, AssuranceChangePlan>();
  const observations: Array<{
    revision: string;
    property_id: string;
    files: Array<{ path: string; blob: string }>;
  }> = [];
  for (let side = 0; side < 2; side += 1) {
    const sha = side === 0 ? delta.base_revision : delta.candidate_revision;
    if (models[side]!.some((file) => file.bytes === null)) {
      changed.forEach((path) => {
        addGap(path, 'source-unavailable');
      });
      continue;
    }
    // A changed candidate model is data awaiting reconciliation, not executable trusted SQL.
    if (side === 1 && modelChanged) continue;
    const directory = snapshotDirectory(repo, sha);
    let db: ReturnType<typeof loadArchitectureDatabase> | null = null;
    let api: API | null = null;
    try {
      db = loadArchitectureDatabase(directory.root);
      const roots = deriveAssurancePropertyTrustRoots(db);
      api = new API({ cwd: directory.root });
      const snapshot = api.updateSnapshot({
        openFiles: [
          ...new Set(
            roots
              .map((root) => root.artifact_id)
              .filter((path) => /\.(?:[cm]?ts|tsx)$/.test(path))
              .map((path) => resolve(directory.root, path)),
          ),
        ],
      });
      try {
        const closure = (rootArtifacts: readonly string[], includeTypeOnly = false): string[] => {
          const tsRoots = rootArtifacts.filter((path) => /\.(?:[cm]?ts|tsx)$/.test(path));
          const otherRoots = rootArtifacts.filter((path) => !/\.(?:[cm]?ts|tsx)$/.test(path));
          const result = runtimeModuleClosure(
            directory.root,
            tsRoots,
            (path) =>
              snapshot
                .getDefaultProjectForFile(resolve(directory.root, path))
                ?.program.getSourceFile(resolve(directory.root, path)) ?? null,
            includeTypeOnly,
          );
          if (result.external_modules.some((module) => !module.startsWith('node:')))
            changed.forEach((path) => {
              addGap(path, 'unresolved-dependency');
            });
          return [...new Set([...otherRoots, ...result.files])].sort();
        };
        const propertyIds = [...new Set(roots.map((root) => root.property_id))].sort();
        const closureByRoots = new Map<string, string[]>();
        for (const property of propertyIds) {
          const artifacts = [
            ...new Set(
              roots.filter((root) => root.property_id === property).map((root) => root.artifact_id),
            ),
          ].sort();
          const files = closure(artifacts);
          closureByRoots.set(canonicalDigest(artifacts), files);
          const source = repositorySnapshot(repo, sha);
          observations.push({
            revision: sha,
            property_id: property,
            files: closure(artifacts, true).map((path) => ({ path, blob: source.blob(path) })),
          });
        }
        const impacts = modelChanged
          ? (
              db
                .prepare('SELECT property_id FROM assurance_property ORDER BY property_id')
                .all() as unknown as Array<{ property_id: string }>
            ).map(({ property_id }) => ({
              property_id,
              changed_artifacts: changed,
              direct: true,
              via_properties: [] as string[],
            }))
          : deriveAffectedAssuranceProperties(
              db,
              changed,
              (artifacts) =>
                closureByRoots.get(canonicalDigest([...artifacts].sort())) ?? closure(artifacts),
              {
                base_package: packageSnapshots[0],
                head_package: packageSnapshots[1],
              },
            );
        for (const impact of impacts) {
          const prior = impactMap.get(impact.property_id);
          impactMap.set(impact.property_id, {
            property_id: impact.property_id,
            direct: impact.direct || (prior?.direct ?? false),
            changed_artifacts: [
              ...new Set([...impact.changed_artifacts, ...(prior?.changed_artifacts ?? [])]),
            ].sort(),
            via_properties: [
              ...new Set([...impact.via_properties, ...(prior?.via_properties ?? [])]),
            ].sort(),
          });
          try {
            const proof = deriveAssuranceChangePlan(db, impact.property_id);
            proofs.set(canonicalDigest(proof), proof);
          } catch {
            impact.changed_artifacts.forEach((path) => {
              addGap(path, 'evidence-unmapped');
            });
          }
        }
      } finally {
        snapshot.dispose();
      }
    } catch (error) {
      const reason =
        error instanceof Error && /TYPESCRIPT_.*(?:IMPORT|REQUIRE|UNRESOLVED)/.test(error.message)
          ? 'unresolved-dependency'
          : 'source-unavailable';
      changed.forEach((path) => {
        addGap(path, reason);
      });
    } finally {
      api?.close();
      db?.close();
      directory.close();
    }
  }
  const impacts = [...impactMap.values()].sort((a, b) =>
    a.property_id.localeCompare(b.property_id),
  );
  const covered = new Set(impacts.flatMap((impact) => impact.changed_artifacts));
  changed
    .filter((path) => !covered.has(path))
    .forEach((path) => {
      addGap(path, 'unmodeled-artifact');
    });
  const evidenceMap = new Map<string, AssuranceChangePlan['evidence'][number]>();
  for (const proof of proofs.values())
    for (const item of proof.evidence) {
      const prior = evidenceMap.get(item.evidence_id);
      evidenceMap.set(item.evidence_id, {
        evidence_id: item.evidence_id,
        obligation_ids: [
          ...new Set([...item.obligation_ids, ...(prior?.obligation_ids ?? [])]),
        ].sort(),
        artifact_ids: [...new Set([...item.artifact_ids, ...(prior?.artifact_ids ?? [])])].sort(),
      });
    }
  const coverageGaps = [
    ...new Map(gaps.map((gap) => [`${gap.artifact_id}:${gap.reason}`, gap])).values(),
  ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id) || a.reason.localeCompare(b.reason));
  return {
    base_revision: delta.base_revision,
    candidate_revision: delta.candidate_revision,
    candidate_tree: delta.candidate_tree,
    model_sha256: canonicalDigest(models),
    dependency_sha256: canonicalDigest(observations),
    changed_artifacts: changed,
    impacts,
    proof_plans: [...proofs.values()].sort((a, b) =>
      canonicalDigest(a).localeCompare(canonicalDigest(b)),
    ),
    evidence: [...evidenceMap.values()].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id)),
    coverage_gaps: coverageGaps,
    validation_mode: modelChanged
      ? 'unsupported'
      : coverageGaps.length === 0
        ? 'selective'
        : policy.baseline_id
          ? 'baseline'
          : 'unsupported',
    baseline_id: policy.baseline_id,
    baseline_sha256: policy.baseline_sha256,
  };
}
