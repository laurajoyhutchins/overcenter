import { api, db } from 'hatchable';
import { withGitHubAppApiClient } from './github-app-auth.js';

export const REPOSITORY_DISPOSITIONS = Object.freeze(['ACTIVE','MAINTENANCE','DORMANT','ARCHIVED','SUPERSEDED']);
const DISPOSED = new Set(['ARCHIVED','SUPERSEDED']);
const ORDINARY_WORK = new Set(['ACTIVE','MAINTENANCE']);

function lifecycleError(code, message, details = null, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

export function canonicalRepository(value) {
  const repository = String(value || '').trim().replace(/^`|`$/g, '').replace(/[.,;:]+$/g, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw lifecycleError('INVALID_REPOSITORY', 'repository must be owner/name', { repository: value || null }, 422);
  return repository;
}

function normalizedDisposition(value) {
  const disposition = String(value || '').trim().toUpperCase();
  if (!REPOSITORY_DISPOSITIONS.includes(disposition)) throw lifecycleError('INVALID_REPOSITORY_DISPOSITION', 'unknown repository disposition', { disposition: value || null }, 422);
  return disposition;
}

export function repositoryHealthProjection(lifecycle) {
  const disposition = normalizedDisposition(lifecycle?.disposition || 'ACTIVE');
  if (DISPOSED.has(disposition)) return { classification: 'disposed_as_intended', include_in_active_health: false };
  if (disposition === 'DORMANT') return { classification: 'dormant_as_intended', include_in_active_health: false };
  return { classification: disposition === 'MAINTENANCE' ? 'maintenance' : 'active', include_in_active_health: true };
}

function project(row, changed = false) {
  const disposition = normalizedDisposition(row.disposition);
  const ordinaryWorkEnabled = ORDINARY_WORK.has(disposition);
  return {
    repository: canonicalRepository(row.repository),
    disposition,
    successor_repository: row.successor_repository ? canonicalRepository(row.successor_repository) : null,
    github_archived: row.github_archived === true,
    github_observed_at: row.github_observed_at || null,
    ordinary_work_enabled: ordinaryWorkEnabled,
    issue_discovery_eligible: ordinaryWorkEnabled,
    linear_projection_enabled: ordinaryWorkEnabled,
    fast_forward_eligible: ordinaryWorkEnabled,
    scheduled_worker_target: ordinaryWorkEnabled,
    health: repositoryHealthProjection({ disposition }),
    transition_reason: row.transition_reason || null,
    transitioned_at: row.transitioned_at || null,
    updated_at: row.updated_at || null,
    changed,
  };
}

export function createPostgresRepositoryDispositionStore(dbBinding = db) {
  return {
    async get(repository) {
      const canonical = canonicalRepository(repository);
      const result = await dbBinding.query('SELECT * FROM portfolio_repository_disposition WHERE lower(repository)=lower($1) LIMIT 1', [canonical]);
      return result.rows?.[0] || null;
    },
    async put(row) {
      const result = await dbBinding.query(`INSERT INTO portfolio_repository_disposition
        (repository, disposition, successor_repository, github_archived, github_observed_at, transition_reason, transitioned_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (repository) DO UPDATE SET
          disposition=EXCLUDED.disposition,
          successor_repository=EXCLUDED.successor_repository,
          github_archived=EXCLUDED.github_archived,
          github_observed_at=EXCLUDED.github_observed_at,
          transition_reason=EXCLUDED.transition_reason,
          transitioned_at=EXCLUDED.transitioned_at,
          updated_at=EXCLUDED.updated_at
        RETURNING *`, [row.repository, row.disposition, row.successor_repository || null, row.github_archived === true, row.github_observed_at || null, row.transition_reason || null, row.transitioned_at, row.updated_at]);
      return result.rows?.[0] || row;
    },
    async list() {
      const result = await dbBinding.query('SELECT * FROM portfolio_repository_disposition ORDER BY lower(repository)');
      return result.rows || [];
    },
  };
}

export function createGitHubRepositoryObserver(options = {}) {
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  return {
    async getRepository(repositoryInput) {
      const repository = canonicalRepository(repositoryInput);
      const [owner, repo] = repository.split('/');
      return withApp(repository, async (client) => {
        const response = await client.call('github', { path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` });
        if (!response || response.status < 200 || response.status >= 300) throw lifecycleError('GITHUB_REPOSITORY_OBSERVATION_FAILED', `GitHub returned HTTP ${response?.status ?? 'unknown'}`, { repository, upstream_status: response?.status || null }, response?.status === 404 ? 404 : 502);
        return response.body;
      }, { permissionProfile: 'portfolio_reconcile' });
    },
  };
}

function semanticEqual(existing, desired) {
  if (!existing) return false;
  return String(existing.disposition) === String(desired.disposition)
    && String(existing.successor_repository || '').toLowerCase() === String(desired.successor_repository || '').toLowerCase()
    && Boolean(existing.github_archived) === Boolean(desired.github_archived)
    && String(existing.transition_reason || '') === String(desired.transition_reason || '');
}

export function createRepositoryLifecycleService({ store, github, now = () => new Date().toISOString() } = {}) {
  if (!store || !github) throw new TypeError('store and github are required');

  async function observe(repositoryInput) {
    const requestedRepository = canonicalRepository(repositoryInput);
    const githubRepository = await github.getRepository(requestedRepository);
    if (!githubRepository) throw lifecycleError('REPOSITORY_NOT_FOUND', 'repository was not found', { repository: requestedRepository }, 404);
    const repository = canonicalRepository(githubRepository.full_name || requestedRepository);
    const archived = githubRepository.archived === true;
    const existing = await store.get(repository);
    const observedAt = now();

    let disposition = existing?.disposition ? normalizedDisposition(existing.disposition) : 'ACTIVE';
    let reason = existing?.transition_reason || 'github_observed_active';
    let transitionedAt = existing?.transitioned_at || observedAt;
    if (archived && !DISPOSED.has(disposition)) {
      disposition = 'ARCHIVED';
      reason = 'github_archived_observed';
      transitionedAt = observedAt;
    }
    // A later external unarchive is evidence only. Once disposed, reactivation is an explicit lifecycle transition.
    const desired = {
      repository,
      disposition,
      successor_repository: existing?.successor_repository || null,
      github_archived: archived,
      github_observed_at: observedAt,
      transition_reason: reason,
      transitioned_at: transitionedAt,
      updated_at: observedAt,
    };
    const changed = !semanticEqual(existing, desired);
    const saved = await store.put(desired);
    return project(saved, changed);
  }

  async function dispose(input = {}) {
    const repository = canonicalRepository(input.repository);
    const disposition = normalizedDisposition(input.disposition || 'ARCHIVED');
    if (!DISPOSED.has(disposition)) throw lifecycleError('INVALID_DISPOSAL_TARGET', 'dispose accepts only ARCHIVED or SUPERSEDED', { disposition }, 422);
    const githubRepository = await github.getRepository(repository);
    const canonical = canonicalRepository(githubRepository?.full_name || repository);
    const githubArchived = githubRepository?.archived === true;
    if (disposition === 'ARCHIVED' && !githubArchived) throw lifecycleError('GITHUB_REPOSITORY_NOT_ARCHIVED', 'ARCHIVED disposition requires authoritative GitHub archived state', { repository: canonical }, 409);
    const existing = await store.get(canonical);
    const successor = input.successor_repository === undefined ? (existing?.successor_repository || null) : (input.successor_repository ? canonicalRepository(input.successor_repository) : null);
    if (successor && successor.toLowerCase() === canonical.toLowerCase()) throw lifecycleError('INVALID_SUCCESSOR_REPOSITORY', 'a repository cannot succeed itself', { repository: canonical }, 422);
    if (Object.prototype.hasOwnProperty.call(input, 'compatibility_bound') || Object.prototype.hasOwnProperty.call(input, 'compatibility_reference')) {
      throw lifecycleError('LEGACY_CONTROL_PLANE_RETIRED', 'repository compatibility execution exceptions are retired; use ordinary repository disposition', { repository: canonical, replacement: 'busbar' }, 410);
    }
    const timestamp = now();
    const desired = {
      repository: canonical,
      disposition,
      successor_repository: successor,
      github_archived: githubArchived,
      github_observed_at: timestamp,
      transition_reason: String(input.reason || existing?.transition_reason || 'repository_disposed').slice(0, 500),
      transitioned_at: existing && semanticEqual(existing, { ...existing, disposition, successor_repository: successor, github_archived: githubArchived, transition_reason: String(input.reason || existing.transition_reason || 'repository_disposed').slice(0, 500) }) ? existing.transitioned_at : timestamp,
      updated_at: timestamp,
    };
    const changed = !semanticEqual(existing, desired);
    const saved = await store.put(desired);
    return project(saved, changed);
  }

  async function transition(input = {}) {
    const repository = canonicalRepository(input.repository);
    const target = normalizedDisposition(input.disposition);
    const existing = await store.get(repository);
    if (!existing) throw lifecycleError('REPOSITORY_DISPOSITION_NOT_FOUND', 'repository has no lifecycle record to transition', { repository }, 404);
    if (input.expected_disposition && normalizedDisposition(input.expected_disposition) !== normalizedDisposition(existing.disposition)) {
      throw lifecycleError('REPOSITORY_DISPOSITION_CHANGED', 'repository disposition no longer matches expected_disposition', { repository, expected_disposition: normalizedDisposition(input.expected_disposition), actual_disposition: normalizedDisposition(existing.disposition) }, 409);
    }
    const githubRepository = await github.getRepository(repository);
    const githubArchived = githubRepository?.archived === true;
    if (githubArchived && !DISPOSED.has(target)) throw lifecycleError('GITHUB_REPOSITORY_ARCHIVED', 'GitHub archived state prohibits transition to an active lifecycle', { repository, target }, 409);
    const timestamp = now();
    const saved = await store.put({
      repository: canonicalRepository(githubRepository?.full_name || repository),
      disposition: target,
      successor_repository: DISPOSED.has(target) ? existing.successor_repository || null : null,
      github_archived: githubArchived,
      github_observed_at: timestamp,
      transition_reason: String(input.reason || 'explicit_lifecycle_transition').slice(0, 500),
      transitioned_at: timestamp,
      updated_at: timestamp,
    });
    return project(saved, true);
  }

  async function verify(repositoryInput) {
    const lifecycle = await observe(repositoryInput);
    return {
      ok: true,
      repository: lifecycle.repository,
      disposition: lifecycle.disposition,
      successor: lifecycle.successor_repository,
      ordinary_work_enabled: lifecycle.ordinary_work_enabled,
      linear_projection_enabled: lifecycle.linear_projection_enabled,
      scheduled_worker_target: lifecycle.scheduled_worker_target,
      fast_forward_eligible: lifecycle.fast_forward_eligible,
      health_classification: lifecycle.health.classification,
      checks: {
        github_archived: lifecycle.github_archived,
        executable_portfolio_work: lifecycle.ordinary_work_enabled ? 'eligible_by_lifecycle' : 'prohibited_by_lifecycle',
        linear_projection: lifecycle.linear_projection_enabled ? 'enabled' : 'disabled',
        scheduled_workers: lifecycle.scheduled_worker_target ? 'eligible' : 'none',
        fast_forward_eligible: lifecycle.fast_forward_eligible,
        issue_discovery_eligible: lifecycle.issue_discovery_eligible,
        successor_recorded: Boolean(lifecycle.successor_repository),
      },
    };
  }

  return { observe, dispose, transition, verify };
}

export function createPostgresRepositoryLifecycleService(options = {}) {
  return createRepositoryLifecycleService({
    store: createPostgresRepositoryDispositionStore(options.db || db),
    github: options.github || createGitHubRepositoryObserver(options),
    now: options.now,
  });
}

export function statusForRepositoryDispositionError(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (/INVALID_|_CHANGED$|_ARCHIVED$|_DISPOSED$/.test(String(error?.code || ''))) return 409;
  return 500;
}