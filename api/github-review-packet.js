import { reviewGithubPullRequestWithGitHubApp } from 'lib/github-review-packet.js';

export const access = 'admin';
export const methods = ['POST'];

function statusFor(result) {
  if (result.ok) return 200;
  if (result.error === 'GITHUB_APP_SETUP_REQUIRED') return 412;
  if (result.error === 'GITHUB_PERMISSION_DENIED' || result.error === 'GITHUB_APP_PERMISSION_DENIED') return 403;
  if (result.error === 'GITHUB_NOT_FOUND' || result.error === 'GITHUB_APP_INSTALLATION_NOT_FOUND') return 404;
  if (result.error === 'HEAD_MISMATCH' || result.error === 'HEAD_MOVED_DURING_INSPECTION') return 409;
  if (String(result.error || '').startsWith('INVALID_')) return 422;
  return 502;
}

export default async function (req, res) {
  const result = await reviewGithubPullRequestWithGitHubApp(req.body || {});
  return res.status(statusFor(result)).json(result);
}