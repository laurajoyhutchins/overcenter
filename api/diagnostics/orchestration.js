import { runOrchestrationTests } from 'lib/orchestration.test.js';
import { runWorkLeaseTests } from 'lib/work-leases.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const [orchestration, leases] = await Promise.all([
    runOrchestrationTests(),
    runWorkLeaseTests(),
  ]);
  const ok = orchestration.ok && leases.ok;
  return res.status(ok ? 200 : 500).json({
    ok,
    suites: { orchestration, leases },
    passed: orchestration.passed + leases.passed,
    failed: orchestration.failed + leases.failed,
  });
}