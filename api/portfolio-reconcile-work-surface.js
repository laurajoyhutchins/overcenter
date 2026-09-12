import { hatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { reconcilePortfolioWorkSurfaceWithExecutionKernel } from 'lib/portfolio-reconcile-execution-runtime.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { statusForPortfolioReconcileResult } from 'lib/portfolio-reconcile-work-surface.js';

export const access = 'admin';
export const methods = ['POST'];

function failure(error) {
  return {
    ok: false,
    error: String(error?.code || 'PORTFOLIO_RECONCILE_ERROR'),
    message: String(error?.message || 'portfolio reconciliation failed'),
    ...(error?.details && typeof error.details === 'object' ? error.details : {}),
    may_have_mutated: error?.may_have_mutated === true,
  };
}

function executionOptions(runId) {
  const configured = hatchableRuntimeProviders.portfolioExecution;
  return {
    ...hatchableRuntimeProviders,
    ...(configured && typeof configured === 'object' ? configured : {}),
    run_id: runId,
  };
}

export default async function (req, res) {
  const runId = typeof req.body?.run_id === 'string' ? req.body.run_id : null;
  const response = await executeCorrelatedCommand(
    'portfolio.reconcile_work_surface',
    req.body || {},
    async (input) => {
      try {
        return await reconcilePortfolioWorkSurfaceWithExecutionKernel(input, executionOptions(runId));
      } catch (error) {
        return failure(error);
      }
    },
    { statusForFailure: statusForPortfolioReconcileResult, flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}
