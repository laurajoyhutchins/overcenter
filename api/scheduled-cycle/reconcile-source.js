import { createPostgresScheduledCycleService } from 'lib/scheduled-cycle-completeness.js';

export const access = 'scheduler';
export const schedule = '39 * * * *';

export default async function (_req, res) {
  const result = await createPostgresScheduledCycleService().reconcile({ participant:'source-data-implementation' });
  return res.status(200).json(result);
}