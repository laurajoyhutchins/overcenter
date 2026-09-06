import { createPostgresExecutionAuthorityService } from './execution-authority.js';
import { createGithubPullRequestRoleAware, reconcileGithubIntegrationRoleAware } from './github-branch-role-runtime.js';
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
    async readHistoricalAuthorities({ project_ref, transition_id, transition_definition_fingerprint }) {
      const result = await db.query(
        `SELECT lease_id::text AS lease_id, run_id, claim_receipt
           FROM work_leases
          WHERE claim_receipt->>'subject'='project_transition'
            AND claim_receipt->'project_transition'->>'project_ref'=$1
            AND claim_receipt->'project_transition'->>'transition_id'=$2
            AND claim_receipt->'project_transition'->>'transition_definition_fingerprint'=$3
          ORDER BY created_at DESC, lease_id DESC
          LIMIT 32`,
        [project_ref, transition_id, transition_definition_fingerprint],
      );
      return (result.rows || []).map((row) => {
        let receipt = row.claim_receipt;
        if (typeof receipt === 'string') {
          try { receipt = JSON.parse(receipt); } catch { return null; }
        }
        const subject = receipt?.project_transition;
        if (receipt?.subject !== 'project_transition' || !subject) return null;
        return Object.freeze({
          subject:'project_transition',
          lease_ref:String(row.lease_id || ''),
          run_id:String(row.run_id || ''),
          repository:String(subject.repository || ''),
          project_ref:String(subject.project_ref || ''),
          transition_id:String(subject.transition_id || ''),
          transition_definition_fingerprint:String(subject.transition_definition_fingerprint || ''),
          authority:Object.freeze({
            kind:'github',
            repository:String(subject.repository || ''),
            revision:String(subject.authority_revision || '').toLowerCase(),
            derivation:String(subject.authority_derivation || ''),
          }),
        });
      }).filter(Boolean);
    },
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
    async integrateCandidate({ repository, pull_request, workspace_branch, development_branch, expected_base, expected_head }) {
      let pullRequest = pull_request;
      if (!pullRequest) {
        const created = await createGithubPullRequestRoleAware({
          repo:repository,
          base:development_branch,
          head:workspace_branch,
          expected_base,
          expected_head,
          title:'project: integrate verified transition candidate',
          body:'Overcenter deterministic project-transition continuation. The candidate is bound to the exact verified head and authoritative base.',
          draft:false,
        }, { db });
        if (!created?.ok) return created;
        pullRequest = Number(created.pull_request);
      }
      return reconcileGithubIntegrationRoleAware({
        repo:repository,
        pull_request:pullRequest,
        expected_head,
        apply:true,
      }, { db });
    },
  });
}