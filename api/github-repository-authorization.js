import { completeGitHubRepositoryAuthorization, githubRepositoryAuthorizationStatus, startGitHubRepositoryAuthorization } from 'lib/github-user-auth.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const action = String(req.body?.action || 'status');
  let result;
  if (action === 'start') result = await startGitHubRepositoryAuthorization();
  else if (action === 'complete') result = await completeGitHubRepositoryAuthorization();
  else if (action === 'status') result = await githubRepositoryAuthorizationStatus();
  else return res.status(400).json({ ok: false, error: 'REQUEST_INVALID', message: 'action must be start, complete, or status' });
  const status = result.ok ? (result.state === 'pending' ? 202 : 200) : (result.error === 'GITHUB_USER_AUTH_REQUIRED' || result.error === 'GITHUB_USER_AUTH_DEVICE_FLOW_DISABLED' ? 412 : 502);
  return res.status(status).json(result);
}