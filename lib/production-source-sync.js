import { planPullSync } from 'lib/source-sync.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

export function bindProductionSourceCoordinates(input = {}, branchRoles) {
  const developmentBranch = typeof branchRoles?.development_branch === 'string' ? branchRoles.development_branch.trim() : '';
  const productionBranch = typeof branchRoles?.production_branch === 'string' ? branchRoles.production_branch.trim() : '';
  if (!developmentBranch || !productionBranch || developmentBranch === productionBranch) {
    fail('SOURCE_SYNC_BRANCH_ROLES_REQUIRED', 'production source materialization requires explicit distinct repository branch roles');
  }
  if (input.github_branch !== undefined && input.github_branch !== null && String(input.github_branch).trim() !== productionBranch) {
    fail('SOURCE_SYNC_BRANCH_ROLE_VIOLATION', 'caller-selected GitHub branch does not match the configured production branch', {
      requested_branch: String(input.github_branch).trim(),
      production_branch: productionBranch,
    });
  }
  return {
    ...input,
    github_branch: productionBranch,
  };
}

export async function planProductionPullSync(input = {}, options = {}) {
  return planPullSync(bindProductionSourceCoordinates(input, options.branchRoles));
}
