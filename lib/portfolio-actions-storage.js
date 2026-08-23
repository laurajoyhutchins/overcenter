import { githubActionsStorageWithGitHubApp } from 'lib/github-actions-storage.js';
import {
  canonicalRepository,
  createPostgresRepositoryDispositionStore,
} from 'lib/repository-disposition.js';

const ACTIVE_DISPOSITIONS = new Set(['ACTIVE', 'MAINTENANCE']);
const REPRODUCIBLE_ARTIFACT_NAMES = new Set([
  'node-coverage',
  'repository-verification-coverage',
]);
const MODES = new Set(['dry_run', 'apply']);
const DEFAULT_RETENTION_DAYS = 30;

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

function object(value, field = 'request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REQUEST', `${field} must be an object`, { field });
  }
  return value;
}

function exactFields(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', 'request contains unknown fields', { unknown });
}

function normalizeRetentionDays(value) {
  const days = Number(value ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 400) {
    fail('INVALID_REQUEST', 'retention_days must be an integer from 1 through 400');
  }
  return days;
}

export function normalizePortfolioActionsStorageRequest(input = {}) {
  const body = object(input);
  exactFields(body, new Set(['mode', 'retention_days']));
  const mode = String(body.mode || 'dry_run').trim();
  if (!MODES.has(mode)) fail('INVALID_REQUEST', 'mode must be dry_run or apply');
  return { mode, retention_days: normalizeRetentionDays(body.retention_days) };
}

function artifactOrder(left, right) {
  return Date.parse(right.created_at || 0) - Date.parse(left.created_at || 0)
    || Number(right.id || 0) - Number(left.id || 0);
}

export function classifyPortfolioArtifacts(artifacts = []) {
  const protectedArtifacts = [];
  const candidates = [];
  const retained = [];
  const knownByName = new Map();

  for (const artifact of artifacts) {
    if (!REPRODUCIBLE_ARTIFACT_NAMES.has(artifact.name)) {
      protectedArtifacts.push({ ...artifact, protection_reason: 'unknown_or_non_reproducible' });
      continue;
    }
    const matches = knownByName.get(artifact.name) || [];
    matches.push(artifact);
    knownByName.set(artifact.name, matches);
  }

  for (const matches of knownByName.values()) {
    const ordered = [...matches].sort(artifactOrder);
    if (ordered.length) retained.push({ ...ordered[0], retention_reason: 'newest_required_reproducible_evidence' });
    for (const artifact of ordered.slice(1)) {
      candidates.push({
        ...artifact,
        deletion_reason: artifact.expired ? 'expired_reproducible_redundant' : 'redundant_reproducible',
      });
    }
  }

  candidates.sort((left, right) => Number(left.id) - Number(right.id));
  protectedArtifacts.sort((left, right) => Number(left.id) - Number(right.id));
  retained.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return {
    artifact_ids: candidates.map((artifact) => Number(artifact.id)),
    candidates,
    protected: protectedArtifacts,
    retained,
    retention_safe: protectedArtifacts.length === 0,
  };
}

function repositoryRows(rows = []) {
  const active = [];
  const skipped = [];
  for (const row of rows) {
    const repository = canonicalRepository(row.repository);
    const disposition = String(row.disposition || 'ACTIVE').trim().toUpperCase();
    if (!ACTIVE_DISPOSITIONS.has(disposition) || row.github_archived === true) {
      skipped.push({
        repository,
        disposition,
        reason: row.github_archived === true ? 'github_archived' : 'inactive_disposition',
      });
      continue;
    }
    active.push({ repository, disposition });
  }
  active.sort((left, right) => left.repository.localeCompare(right.repository));
  skipped.sort((left, right) => left.repository.localeCompare(right.repository));
  return { active, skipped };
}

export async function reconcilePortfolioActionsStorage(input = {}, options = {}) {
  let normalized;
  try {
    normalized = normalizePortfolioActionsStorageRequest(input);
  } catch (error) {
    return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}) };
  }

  const store = options.store || createPostgresRepositoryDispositionStore();
  const storageCommand = options.storageCommand || githubActionsStorageWithGitHubApp;
  let rows;
  try {
    rows = await store.list();
  } catch (error) {
    return {
      ok: false,
      error: 'PORTFOLIO_REPOSITORY_DISCOVERY_FAILED',
      message: String(error?.message || error),
      may_have_mutated: false,
    };
  }

  const discovered = repositoryRows(rows);
  const repositories = [];
  let reclaimedBytes = 0;
  let deletedArtifacts = 0;
  let candidateArtifacts = 0;
  let protectedArtifacts = 0;
  let failedRepositories = 0;
  let observedBytes = 0;
  let liveBytes = 0;

  for (const target of discovered.active) {
    const inspected = await storageCommand({ repo: target.repository, operation: 'inspect' });
    if (!inspected?.ok) {
      failedRepositories += 1;
      repositories.push({
        repository: target.repository,
        disposition: target.disposition,
        outcome: 'failed',
        phase: 'inspect',
        error: inspected?.error || 'GITHUB_ACTIONS_STORAGE_INSPECTION_FAILED',
        message: inspected?.message || 'Actions storage inspection failed.',
        may_have_mutated: Boolean(inspected?.may_have_mutated),
      });
      continue;
    }

    observedBytes += Number(inspected.total_size_in_bytes || 0);
    liveBytes += Number(inspected.live_size_in_bytes || 0);
    const classification = classifyPortfolioArtifacts(inspected.artifacts || []);
    candidateArtifacts += classification.candidates.length;
    protectedArtifacts += classification.protected.length;
    const report = {
      repository: target.repository,
      disposition: target.disposition,
      outcome: normalized.mode === 'dry_run' ? 'planned' : 'unchanged',
      artifact_count: inspected.artifact_count,
      total_size_in_bytes: inspected.total_size_in_bytes,
      live_size_in_bytes: inspected.live_size_in_bytes,
      candidate_artifact_ids: classification.artifact_ids,
      candidates: classification.candidates,
      candidate_size_in_bytes: classification.candidates.reduce((sum, artifact) => sum + Number(artifact.size_in_bytes || 0), 0),
      retained: classification.retained,
      protected: classification.protected,
      retention: classification.retention_safe
        ? { outcome: normalized.mode === 'dry_run' ? 'planned' : 'pending', days: normalized.retention_days }
        : { outcome: 'skipped_protected_evidence', days: null },
    };

    if (normalized.mode === 'dry_run') {
      repositories.push(report);
      continue;
    }

    if (classification.artifact_ids.length) {
      const deleted = await storageCommand({
        repo: target.repository,
        operation: 'delete_artifacts',
        artifact_ids: classification.artifact_ids,
      });
      if (!deleted?.ok) {
        failedRepositories += 1;
        repositories.push({
          ...report,
          outcome: 'failed',
          phase: 'delete',
          error: deleted?.error || 'GITHUB_ACTIONS_STORAGE_DELETE_FAILED',
          message: deleted?.message || 'Actions artifact deletion failed.',
          may_have_mutated: Boolean(deleted?.may_have_mutated),
          deletion: deleted,
        });
        continue;
      }
      reclaimedBytes += Number(deleted.reclaimed_size_in_bytes || 0);
      deletedArtifacts += Number(deleted.deleted_count || 0);
      report.deletion = deleted;
      report.outcome = Number(deleted.deleted_count || 0) > 0 ? 'reconciled' : 'unchanged';
    }

    if (classification.retention_safe) {
      const retention = await storageCommand({ repo: target.repository, operation: 'set_retention', days: normalized.retention_days });
      report.retention = retention;
      if (!retention?.ok) {
        failedRepositories += 1;
        report.outcome = 'failed';
        report.phase = 'retention';
        report.error = retention?.error || 'GITHUB_ACTIONS_RETENTION_FAILED';
        report.message = retention?.message || 'Actions retention reconciliation failed.';
        report.may_have_mutated = Boolean(retention?.may_have_mutated);
      } else if (retention.outcome === 'updated') {
        report.outcome = 'reconciled';
      }
    }

    repositories.push(report);
  }

  return {
    ok: failedRepositories === 0,
    outcome: failedRepositories === 0 ? 'completed' : 'partial_failure',
    mode: normalized.mode,
    retention_days: normalized.retention_days,
    discovered_repository_count: rows.length,
    active_repository_count: discovered.active.length,
    skipped_repository_count: discovered.skipped.length,
    failed_repository_count: failedRepositories,
    candidate_artifact_count: candidateArtifacts,
    protected_artifact_count: protectedArtifacts,
    observed_size_in_bytes: observedBytes,
    live_size_in_bytes: liveBytes,
    deleted_artifact_count: deletedArtifacts,
    reclaimed_size_in_bytes: reclaimedBytes,
    skipped_repositories: discovered.skipped,
    repositories,
  };
}
