import { planPullSync } from 'lib/source-sync.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

export function bindProductionSourceCoordinates(input = {}, branchRoles) {
  if (!branchRoles || branchRoles.development_branch !== 'dev' || typeof branchRoles.production_branch !== 'string' || !branchRoles.production_branch || branchRoles.production_branch === 'dev') {
    fail('SOURCE_SYNC_BRANCH_ROLES_REQUIRED', 'production source materialization requires explicit repository branch roles');
  }
  if (input.github_branch !== undefined && input.github_branch !== null && String(input.github_branch).trim() !== branchRoles.production_branch) {
    fail('SOURCE_SYNC_BRANCH_ROLE_VIOLATION', 'caller-selected GitHub branch does not match the configured production branch', {
      requested_branch: String(input.github_branch).trim(),
      production_branch: branchRoles.production_branch,
    });
  }
  return {
    ...input,
    github_branch: branchRoles.production_branch,
  };
}

export async function planProductionPullSync(input = {}, options = {}) {
  return planPullSync(bindProductionSourceCoordinates(input, options.branchRoles));
}
