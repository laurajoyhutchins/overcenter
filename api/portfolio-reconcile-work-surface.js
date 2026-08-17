import { executeCommand } from 'lib/command-response.js';
import {
  reconcilePortfolioWorkSurfaceWithGitHubApp,
  statusForPortfolioReconcileResult,
} from 'lib/portfolio-reconcile-work-surface.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCommand(
    'portfolio.reconcile_work_surface',
    () => reconcilePortfolioWorkSurfaceWithGitHubApp(req.body || {}),
    { statusForFailure: statusForPortfolioReconcileResult, flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}