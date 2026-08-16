import { runPortfolioReconcileWorkSurfaceTests } from 'lib/portfolio-reconcile-work-surface.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  const result = await runPortfolioReconcileWorkSurfaceTests();
  return res.status(result.ok ? 200 : 500).json({
    diagnostic: 'portfolio_reconcile_work_surface',
    isolated: true,
    production_mutation: false,
    ...result,
  });
}