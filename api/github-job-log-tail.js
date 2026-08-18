import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const repo = String(req.query?.repo || '');
  const jobId = Number(req.query?.job_id);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isInteger(jobId) || jobId <= 0) {
    return res.status(422).json({ ok: false, error: 'INVALID_REQUEST' });
  }
  try {
    const result = await withGitHubAppApiClient(repo, async (apiClient) => apiClient.call('github', {
      method: 'GET',
      path: `/repos/${repo}/actions/jobs/${jobId}/logs`,
    }), { permissionProfile: 'actions_storage_read' });
    const text = typeof result?.body === 'string' ? result.body : JSON.stringify(result?.body || '');
    return res.json({ ok: true, status: result?.status || null, tail: text.slice(-16000) });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error?.code || 'GITHUB_LOG_READ_FAILED', message: String(error?.message || error) });
  }
}