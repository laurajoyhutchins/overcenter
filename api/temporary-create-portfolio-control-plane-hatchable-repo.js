import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

export const access = 'admin';
export const methods = ['POST'];

const OWNER = 'laurajoyhutchins';
const TEMPLATE_REPO = `${OWNER}/test`;
const TARGET_NAME = 'portfolio-control-plane-hatchable';
const TARGET_REPO = `${OWNER}/${TARGET_NAME}`;

async function call(client, method, path, body) {
  const response = await client.call('github', { method, path, ...(body === undefined ? {} : { body }) });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(response.body?.message || `GitHub returned HTTP ${response.status}`);
    error.status = response.status;
    error.body = response.body;
    throw error;
  }
  return response.body;
}

export default async function (_req, res) {
  let templateEnabled = false;
  try {
    await withGitHubAppApiClient(TEMPLATE_REPO, async (client) => {
      const existing = await client.call('github', { method: 'GET', path: `/repos/${TARGET_REPO}` });
      if (existing.status === 200) throw Object.assign(new Error('Target repository already exists.'), { code: 'TARGET_EXISTS' });
      if (existing.status !== 404) throw Object.assign(new Error(`Unexpected target preflight HTTP ${existing.status}`), { code: 'TARGET_PREFLIGHT_FAILED' });

      await call(client, 'PATCH', `/repos/${TEMPLATE_REPO}`, { is_template: true });
      templateEnabled = true;
      await call(client, 'POST', `/repos/${TEMPLATE_REPO}/generate`, {
        owner: OWNER,
        name: TARGET_NAME,
        description: 'Hatchable mirror target for Portfolio Control Plane.',
        private: true,
        include_all_branches: false,
      });
    }, { permissionProfile: 'default_branch_migrate' });

    if (templateEnabled) {
      await withGitHubAppApiClient(TEMPLATE_REPO, async (client) => {
        await call(client, 'PATCH', `/repos/${TEMPLATE_REPO}`, { is_template: false });
      }, { permissionProfile: 'default_branch_migrate' });
      templateEnabled = false;
    }

    const result = await withGitHubAppApiClient(TARGET_REPO, async (client) => {
      const repo = await call(client, 'GET', `/repos/${TARGET_REPO}`);
      if (repo.private !== true) throw Object.assign(new Error('Created repository is not private.'), { code: 'TARGET_NOT_PRIVATE' });

      const currentRef = await call(client, 'GET', `/repos/${TARGET_REPO}/git/ref/heads/main`);
      const seedSha = currentRef?.object?.sha;
      if (!seedSha) throw Object.assign(new Error('Created repository has no main seed ref.'), { code: 'TARGET_SEED_MISSING' });

      const tree = await call(client, 'POST', `/repos/${TARGET_REPO}/git/trees`, { tree: [] });
      const commit = await call(client, 'POST', `/repos/${TARGET_REPO}/git/commits`, {
        message: 'Initialize empty Hatchable mirror target',
        tree: tree.sha,
        parents: [],
      });
      await call(client, 'PATCH', `/repos/${TARGET_REPO}/git/refs/heads/main`, { sha: commit.sha, force: true });

      const verifiedRef = await call(client, 'GET', `/repos/${TARGET_REPO}/git/ref/heads/main`);
      const verifiedTree = await call(client, 'GET', `/repos/${TARGET_REPO}/git/trees/${tree.sha}?recursive=1`);
      const blobs = (verifiedTree.tree || []).filter((entry) => entry.type === 'blob');
      if (verifiedRef?.object?.sha !== commit.sha || blobs.length !== 0) {
        throw Object.assign(new Error('Empty repository postcondition failed.'), { code: 'EMPTY_REPO_VERIFY_FAILED' });
      }

      return {
        ok: true,
        repository: TARGET_REPO,
        private: true,
        default_branch: 'main',
        head_sha: commit.sha,
        seed_sha_replaced: seedSha,
        reachable_file_count: 0,
      };
    }, { permissionProfile: 'default_branch_migrate' });

    return res.json(result);
  } catch (error) {
    if (templateEnabled) {
      try {
        await withGitHubAppApiClient(TEMPLATE_REPO, async (client) => {
          await call(client, 'PATCH', `/repos/${TEMPLATE_REPO}`, { is_template: false });
        }, { permissionProfile: 'default_branch_migrate' });
      } catch {}
    }
    return res.status(error.status && Number.isInteger(error.status) ? error.status : 500).json({
      ok: false,
      error: error.code || 'CREATE_REPOSITORY_FAILED',
      message: String(error.message || error),
    });
  }
}