import { sourceMirrorGitHubTransport } from 'lib/source-mirror-github-transport.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const result = await sourceMirrorGitHubTransport(req.body || {});
  const status = result.ok ? 200 : (result.error === 'SOURCE_MIRROR_GITHUB_REQUEST_INVALID' ? 422 : result.error === 'SOURCE_MIRROR_BOOTSTRAP_DRIFT' ? 409 : 502);
  return res.status(status).json(result);
}