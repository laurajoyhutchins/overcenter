import { hatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { createPostgresScheduledCycleService } from 'lib/scheduled-cycle-completeness.js';

export const access = 'scheduler';

export default async function (_req, res) {
  const result = await createPostgresScheduledCycleService(hatchableRuntimeProviders).reconcile({ participant:'repository-implementation' });
  return res.status(200).json(result);
}