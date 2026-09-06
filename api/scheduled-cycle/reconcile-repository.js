import { createPostgresScheduledCycleService } from 'lib/scheduled-cycle-completeness.js';

export const access = 'scheduler';

export default async function (_req, res) {
  const result = await createPostgresScheduledCycleService().reconcile({ participant:'repository-implementation' });
  return res.status(200).json(result);
}