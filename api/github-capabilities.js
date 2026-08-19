import { inspectGitHubAppCapabilities } from 'lib/github-app-auth.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    const result = await inspectGitHubAppCapabilities(req.body?.repo);
    return res.json(result);
  } catch (error) {
    const code = String(error?.code || 'GITHUB_CAPABILITY_INSPECTION_ERROR');
    const status = code === 'INVALID_REPO' ? 422 : 500;
    return res.status(status).json({ ok: false, error: code, message: String(error?.message || error) });
  }
}