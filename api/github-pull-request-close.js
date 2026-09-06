import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { closeGithubPullRequestWithGitHubApp } from 'lib/github-work-surface-retirement-github-app.js';

export const access = 'admin';
export const methods = ['POST'];

function statusFor(result) {
  if (result?.ok) return 200;
  if (result?.error === 'GITHUB_APP_SETUP_REQUIRED') return 412;
  if (result?.error === 'GITHUB_PERMISSION_DENIED' || result?.error === 'GITHUB_APP_PERMISSION_DENIED') return 403;
  if (result?.error === 'GITHUB_NOT_FOUND' || result?.error === 'GITHUB_APP_INSTALLATION_NOT_FOUND') return 404;
  if (result?.error === 'HEAD_MISMATCH' || String(result?.error || '').endsWith('_INDETERMINATE')) return 409;
  if (String(result?.error || '').startsWith('INVALID_') || String(result?.error || '').endsWith('_MISMATCH')) return 422;
  return 502;
}

export default async function (req, res) {
  const response = await executeCorrelatedCommand('github.pull_request.close', req.body || {}, (input) => closeGithubPullRequestWithGitHubApp(input), { statusForFailure:statusFor, flattenDetails:true });
  return res.status(response.status).json(response.body);
}