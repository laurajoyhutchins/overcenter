import { db } from 'hatchable';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*[~^:?*\[\\\s])[^/]+(?:\/[^/]+)*$/;

function error(code, message, details = null, status = 409) {
  return Object.assign(new Error(message), { code, details, status });
}

function requiredText(value, field, max = 1024) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw error('REPOSITORY_BRANCH_ROLE_INVALID', `${field} is invalid`, { field }, 422);
  return text;
}

function canonicalRepository(value) {
  const repository = requiredText(value, 'repository', 256);
  if (!REPO.test(repository)) throw error('REPOSITORY_BRANCH_ROLE_INVALID', 'repository must be owner/repo', { repository }, 422);
  return repository;
}

function safeBranch(value, field) {
  const branch = requiredText(value, field, 255);
  if (!SAFE_BRANCH.test(branch) || branch.startsWith('refs/') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('//')) {
    throw error('REPOSITORY_BRANCH_ROLE_INVALID', `${field} is not a safe branch name`, { field, branch }, 422);
  }
  return branch;
}

export function normalizeRepositoryBranchRoleBinding(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw error('REPOSITORY_BRANCH_ROLE_INVALID', 'branch-role binding must be an object', null, 422);
  }
  const repository = canonicalRepository(input.repository);
  const developmentBranch = safeBranch(input.development_branch, 'development_branch');
  const productionBranch = safeBranch(input.production_branch, 'production_branch');
  if (developmentBranch !== 'dev') {
    throw error('REPOSITORY_BRANCH_ROLE_INVALID', 'development branch must be dev', { development_branch: developmentBranch }, 422);
  }
  if (developmentBranch === productionBranch) {
    throw error('REPOSITORY_BRANCH_ROLE_CONFLICT', 'development and production branches must differ', { branch: developmentBranch }, 409);
  }
  return Object.freeze({
    repository,
    development_branch: developmentBranch,
    production_branch: productionBranch,
    production_source_ref: requiredText(input.production_source_ref, 'production_source_ref', 1024),
  });
}

function project(row, changed = false) {
  const binding = normalizeRepositoryBranchRoleBinding(row);
  return { ok: true, ...binding, changed };
}

export function createPostgresRepositoryBranchRoleStore(dbBinding = db) {
  return {
    async get(repositoryInput) {
      const repository = canonicalRepository(repositoryInput);
      const result = await dbBinding.query(
        `SELECT repository, development_branch, production_branch, production_source_ref, created_at, updated_at
           FROM portfolio_repository_branch_roles
          WHERE lower(repository) = lower($1)
          LIMIT 1`,
        [repository],
      );
      return result.rows?.[0] || null;
    },
    async insert(binding) {
      const result = await dbBinding.query(
        `INSERT INTO portfolio_repository_branch_roles
           (repository, development_branch, production_branch, production_source_ref, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (repository) DO NOTHING
         RETURNING repository, development_branch, production_branch, production_source_ref, created_at, updated_at`,
        [binding.repository, binding.development_branch, binding.production_branch, binding.production_source_ref],
      );
      return result.rows?.[0] || null;
    },
  };
}

function sameBinding(left, right) {
  return left
    && String(left.repository).toLowerCase() === String(right.repository).toLowerCase()
    && left.development_branch === right.development_branch
    && left.production_branch === right.production_branch
    && left.production_source_ref === right.production_source_ref;
}

export function createRepositoryBranchRoleService({ store } = {}) {
  if (!store) throw new TypeError('store is required');
  return {
    async get(repository) {
      const row = await store.get(repository);
      return row ? project(row, false) : null;
    },
    async ensure(input) {
      const binding = normalizeRepositoryBranchRoleBinding(input);
      const existing = await store.get(binding.repository);
      if (existing) {
        if (sameBinding(existing, binding)) return project(existing, false);
        throw error('REPOSITORY_BRANCH_ROLE_CHANGED', 'repository branch-role binding already exists with different coordinates', {
          repository: binding.repository,
          existing: normalizeRepositoryBranchRoleBinding(existing),
          requested: binding,
        }, 409);
      }
      const inserted = await store.insert(binding);
      if (inserted) return project(inserted, true);
      const raced = await store.get(binding.repository);
      if (sameBinding(raced, binding)) return project(raced, false);
      throw error('REPOSITORY_BRANCH_ROLE_CHANGED', 'repository branch-role binding changed concurrently', {
        repository: binding.repository,
        existing: raced ? normalizeRepositoryBranchRoleBinding(raced) : null,
        requested: binding,
      }, 409);
    },
  };
}

export function createPostgresRepositoryBranchRoleService(options = {}) {
  return createRepositoryBranchRoleService({ store: options.store || createPostgresRepositoryBranchRoleStore(options.db || db) });
}

export async function resolveRepositoryBranchRoles(repository, options = {}) {
  const service = options.service || createPostgresRepositoryBranchRoleService(options);
  return service.get(repository);
}

export function assertOrdinaryWorkTarget(branchInput, roles) {
  if (!roles) return;
  const branch = safeBranch(branchInput, 'branch');
  if ([roles.development_branch, roles.production_branch].includes(branch)) {
    throw error('GITHUB_BRANCH_ROLE_VIOLATION', 'ordinary mutation cannot target a managed development or production branch', {
      branch,
      development_branch: roles.development_branch,
      production_branch: roles.production_branch,
      may_have_mutated: false,
    }, 409);
  }
}

export function assertDevelopmentBase(branchInput, roles) {
  if (!roles) return;
  const branch = safeBranch(branchInput, 'base');
  if (branch !== roles.development_branch) {
    throw error('GITHUB_BRANCH_ROLE_VIOLATION', 'managed pull requests and integration must target the development branch', {
      base: branch,
      expected_base: roles.development_branch,
      production_branch: roles.production_branch,
      may_have_mutated: false,
    }, 409);
  }
}

export function statusForRepositoryBranchRoleError(errorInput) {
  if (Number.isInteger(errorInput?.status)) return errorInput.status;
  if (String(errorInput?.code || '').includes('INVALID')) return 422;
  return 409;
}
