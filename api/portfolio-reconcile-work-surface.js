import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcilePortfolioWorkSurfaceWithCompactState } from 'lib/compact-portfolio-reconcile-runtime.js';
import { statusForPortfolioReconcileResult } from 'lib/portfolio-reconcile-work-surface.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const runId = typeof req.body?.run_id === 'string' ? req.body.run_id : null;
  const response = await executeCorrelatedCommand(
    'portfolio.reconcile_work_surface',
    req.body || {},
    (input) => reconcilePortfolioWorkSurfaceWithCompactState(input, { run_id:runId }),
    { statusForFailure: statusForPortfolioReconcileResult, flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}