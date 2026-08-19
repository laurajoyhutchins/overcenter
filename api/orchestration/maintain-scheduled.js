import { createPostgresOrchestrationMaintenanceService } from 'lib/orchestration-runs.js';

export const access = 'scheduler';
export const methods = ['POST'];
export const schedule = '17 * * * *';

export default async function (_req, res) {
  const result = await createPostgresOrchestrationMaintenanceService({ limit: 100 }).maintain();
  return res.status(200).json(result);
}