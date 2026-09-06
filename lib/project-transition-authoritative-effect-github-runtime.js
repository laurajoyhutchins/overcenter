import { createPostgresExecutionAuthorityService } from './execution-authority.js';
import { withGitHubAppApiClient } from './github-app-auth.js';
import { deriveProjectTransitionGithubWorkspace } from './project-transition-github-workspace.js';
import { resolveRepositoryBranchRoles } from './repository-branch-roles.js';
import { projectTransitionAuthoritativeEffectConfirmationFor } from './project-transition-authoritative-effect.js';

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details });
}

function responseBody(response, phase) {
  const status = Number(response?.status || 0);
  if (status < 200 || status >= 300) {
    fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_GITHUB_READ_FAILED', `GitHub authoritative read failed during ${phase}`, {
      phase,
      upstream_status:status || null,
      may_have_mutated:false,
    });
  }
  return response?.body;
}

export function createPostgresProjectTransitionAuthoritativeEffectConfirmationService(options = {}) {
  const db = options.db;
  if (!db || typeof db.query !== 'function') fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_RUNTIME_INVALID', 'database binding is required');
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  const executionAuthority = options.executionAuthority || createPostgresExecutionAuthorityService({ db });

  async function githubRead(repository, permissionProfile, path, query = undefined) {
    return withApp(repository, async (client) => {
      const response = await client.call('github', { path, ...(query ? { query } : {}) });
      return responseBody(response, path);
    }, { permissionProfile });
  }

  return projectTransitionAuthoritativeEffectConfirmationFor({
    async readLeaseRef(runId) {
      const result = await db.query('SELECT lease_ref FROM execution_state WHERE run_id=$1 LIMIT 1', [runId]);
      return result.rows?.[0]?.lease_ref || null;
    },
    executionAuthority,
    deriveWorkspace:deriveProjectTransitionGithubWorkspace,
    resolveBranchRoles:(repository) => resolveRepositoryBranchRoles(repository, { db }),
    async readPullRequests({ repository, head, base }) {
      const [owner, name] = repository.split('/');
      return githubRead(repository, 'review_packet', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`, {
        state:'all', head:`${owner}:${head}`, base, per_page:100,
      });
    },
    async readBranchHead({ repository, branch }) {
      const [owner, name] = repository.split('/');
      const body = await githubRead(repository, 'project_facts', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branch)}`);
      return body?.commit?.sha || null;
    },
    async compareCommits({ repository, base, head }) {
      const [owner, name] = repository.split('/');
      return githubRead(repository, 'project_facts', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    },
  });
}