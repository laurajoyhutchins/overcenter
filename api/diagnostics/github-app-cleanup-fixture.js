import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

export const access = 'admin';
export const methods = ['POST'];

const FIXTURE_REPO = 'laurajoyhutchins/test';
const FIXTURE_BRANCH = 'agent/github-app-changeset-fixture-20260816';

export default async function (req, res) {
  const repo = req.body?.repo;
  const branch = req.body?.branch;
  if (repo !== FIXTURE_REPO || branch !== FIXTURE_BRANCH) {
    return res.status(422).json({ ok: false, error: 'FIXTURE_MISMATCH' });
  }

  const [owner, name] = repo.split('/');
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  return withGitHubAppApiClient(repo, async (apiClient) => {
    const response = await apiClient.call('github', {
      method: 'DELETE',
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs/heads/${encodedBranch}`,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'Hatchable-Portfolio-Control-Plane/1.0',
      },
    });
    if (response.status !== 204) {
      return res.status(response.status || 502).json({
        ok: false,
        error: 'FIXTURE_BRANCH_DELETE_FAILED',
        upstream_status: response.status || null,
        message: response.body?.message || 'GitHub branch deletion failed.',
      });
    }
    return res.json({ ok: true, repo, branch, deleted: true });
  });
}