import { createPostgresScheduledCycleService } from 'lib/scheduled-cycle-completeness.js';

export const access = 'scheduler';
export const schedule = '51 * * * *';

export default async function (_req, res) {
  const result = await createPostgresScheduledCycleService().reconcile({ participant:'exact-head-verification' });
  return res.status(200).json(result);
}