import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import {
  reconcilePortfolioWorkSurfaceWithGitHubApp,
  statusForPortfolioReconcileResult,
} from 'lib/portfolio-reconcile-work-surface.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'portfolio.reconcile_work_surface',
    req.body || {},
    (input) => reconcilePortfolioWorkSurfaceWithGitHubApp(input),
    { statusForFailure: statusForPortfolioReconcileResult, flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}