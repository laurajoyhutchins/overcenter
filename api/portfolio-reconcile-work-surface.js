import {
  reconcilePortfolioWorkSurfaceWithGitHubApp,
  statusForPortfolioReconcileResult,
} from 'lib/portfolio-reconcile-work-surface.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const result = await reconcilePortfolioWorkSurfaceWithGitHubApp(req.body || {});
  return res.status(statusForPortfolioReconcileResult(result)).json(result);
}