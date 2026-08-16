import { db } from 'hatchable';
import { applyGithubChangesetWithGitHubApp } from 'lib/github-apply-changeset.js';

export const access = 'admin';
export const methods = ['POST'];

function statusFor(result) {
  if (result.ok) return 200;
  if (result.error === 'GITHUB_SETUP_REQUIRED' || result.error === 'GITHUB_APP_SETUP_REQUIRED') return 412;
  if (result.error === 'GITHUB_PERMISSION_DENIED' || result.error === 'GITHUB_APP_PERMISSION_DENIED') return 403;
  if (result.error === 'GITHUB_NOT_FOUND' || result.error === 'GITHUB_APP_INSTALLATION_NOT_FOUND') return 404;
  if (['HEAD_MISMATCH', 'BRANCH_CREATION_RACE', 'TARGET_BRANCH_DISAPPEARED', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS', 'CREATE_TARGET_EXISTS', 'UPDATE_TARGET_MISSING', 'DELETE_TARGET_MISSING', 'GITHUB_CONFLICT'].includes(result.error)) return 409;
  if (result.error === 'GITHUB_REF_REJECTED') return 422;
  if (String(result.error || '').startsWith('INVALID_') || result.error === 'DUPLICATE_PATH' || result.error === 'UNSUPPORTED_BINARY_PAYLOAD' || result.error === 'UNSUPPORTED_TARGET_TYPE') return 422;
  return 502;
}

export default async function (req, res) {
  const result = await applyGithubChangesetWithGitHubApp(req.body || {}, { db });
  return res.status(statusFor(result)).json(result);
}