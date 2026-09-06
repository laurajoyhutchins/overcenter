import { hatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { createPostgresScheduledCycleService } from 'lib/scheduled-cycle-completeness.js';
import { createPostgresDeterministicWorkSettlementService } from 'lib/deterministic-work-settlement.js';

export const access = 'scheduler';

export default async function (_req, res) {
  const cycle = await createPostgresScheduledCycleService(hatchableRuntimeProviders).reconcile({ participant:'portfolio-integration' });
  const deterministicWork = await createPostgresDeterministicWorkSettlementService().reconcile();
  return res.status(200).json({
    ...cycle,
    work_authority_changed: deterministicWork.settled_count > 0,
    deterministic_work_settlement: deterministicWork,
  });
}