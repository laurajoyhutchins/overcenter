import { runOrchestrationTests } from 'lib/orchestration.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const result = await runOrchestrationTests();
  return res.status(result.ok ? 200 : 500).json(result);
}