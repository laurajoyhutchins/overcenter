import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const repo = String(req.body?.repo || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return res.status(400).json({ ok: false, error: 'INVALID_REPO' });
  }
  const profiles = ['review_packet', 'review_pull_requests', 'review_checks', 'review_statuses', 'review_protection'];
  const results = {};
  for (const profile of profiles) {
    try {
      await withGitHubAppApiClient(repo, async () => ({ minted: true }), { permissionProfile: profile });
      results[profile] = { minted: true };
    } catch (error) {
      results[profile] = {
        minted: false,
        status: error?.status ? Number(error.status) : null,
        code: error?.code || null,
        message: String(error?.message || error),
      };
    }
  }
  return res.json({ ok: true, repo, results });
}