import { api, db } from 'hatchable';
import { createCompactPortfolioReconcileReceiptStore } from './compact-portfolio-reconcile-receipt-store.js';
import { createPostgresPortfolioReconcileService } from './portfolio-reconcile-work-surface.js';

export function createCompactPortfolioReconcileService(options = {}) {
  const dbBinding = options.db || db;
  return createPostgresPortfolioReconcileService({
    ...options,
    db:dbBinding,
    api:options.api || api,
    receiptStore:options.receiptStore || createCompactPortfolioReconcileReceiptStore(dbBinding, { now:options.now, runId:options.run_id || null }),
  });
}

export async function reconcilePortfolioWorkSurfaceWithCompactState(input, options = {}) {
  return createCompactPortfolioReconcileService(options).reconcile(input);
}