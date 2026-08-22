import { runSourceSyncRegressionTests } from 'lib/source-sync.test.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (_req, res) {
  const result = await runSourceSyncRegressionTests();
  res.status(result.ok ? 200 : 500).json(result);
}