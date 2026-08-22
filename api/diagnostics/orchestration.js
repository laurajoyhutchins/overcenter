import { runOrchestrationTests } from 'lib/orchestration.test.js';
import { runWorkLeaseTests } from 'lib/work-leases.test.js';
import { runWorkerTransportTests } from 'lib/worker-transport.test.js';
import { runPortfolioReconcileWorkSurfaceTests } from 'lib/portfolio-reconcile-work-surface.test.js';
import { runLinearArchiveTests } from 'lib/linear-archive.test.js';
import { runLinearMaintenanceTests } from 'lib/linear-maintenance.test.js';
import { runScheduledCycleCompletenessTests } from 'lib/scheduled-cycle-completeness.test.js';
import { runRepositoryDispositionTests } from 'lib/repository-disposition.test.js';
import { runRepositoryDisposalTests } from 'lib/repository-disposal.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const [orchestration, leases, workerTransport, portfolioReconcile, linearArchive, linearMaintenance, scheduledCycleCompleteness, repositoryDisposition, repositoryDisposal] = await Promise.all([
    runOrchestrationTests(),
    runWorkLeaseTests(),
    runWorkerTransportTests(),
    runPortfolioReconcileWorkSurfaceTests(),
    runLinearArchiveTests(),
    runLinearMaintenanceTests(),
    runScheduledCycleCompletenessTests(),
    runRepositoryDispositionTests(),
    runRepositoryDisposalTests(),
  ]);
  const ok = orchestration.ok && leases.ok && workerTransport.ok && portfolioReconcile.ok && linearArchive.ok && linearMaintenance.ok && scheduledCycleCompleteness.ok && repositoryDisposition.ok && repositoryDisposal.ok;
  return res.status(ok ? 200 : 500).json({
    ok,
    suites: { orchestration, leases, worker_transport: workerTransport, portfolio_reconcile: portfolioReconcile, linear_archive: linearArchive, linear_maintenance: linearMaintenance, scheduled_cycle_completeness: scheduledCycleCompleteness, repository_disposition: repositoryDisposition, repository_disposal: repositoryDisposal },
    passed: orchestration.passed + leases.passed + workerTransport.passed + portfolioReconcile.passed + linearArchive.passed + linearMaintenance.passed + scheduledCycleCompleteness.passed + repositoryDisposition.passed + repositoryDisposal.passed,
    failed: orchestration.failed + leases.failed + workerTransport.failed + portfolioReconcile.failed + linearArchive.failed + linearMaintenance.failed + scheduledCycleCompleteness.failed + repositoryDisposition.failed + repositoryDisposal.failed,
  });
}