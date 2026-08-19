import { runSourceMirrorGitHubTransportTests } from 'lib/source-mirror-github-transport.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const result = await runSourceMirrorGitHubTransportTests();
  return res.status(result.ok ? 200 : 500).json(result);
}