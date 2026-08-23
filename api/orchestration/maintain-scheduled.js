import { createPostgresOrchestrationMaintenanceService } from 'lib/orchestration-runs.js';
import { reconcilePortfolioActionsStorage } from 'lib/portfolio-actions-storage.js';

export const access = 'scheduler';
export const methods = ['POST'];
export const schedule = '17 * * * *';

export default async function (_req, res) {
  const orchestration = await createPostgresOrchestrationMaintenanceService({ limit: 100 }).maintain();
  const actionsStorage = await reconcilePortfolioActionsStorage({ mode: 'apply' });
  return res.status(200).json({
    ok: orchestration?.ok !== false && actionsStorage.ok === true,
    orchestration,
    actions_storage: actionsStorage,
  });
}
