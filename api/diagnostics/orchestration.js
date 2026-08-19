import { runOrchestrationTests } from 'lib/orchestration.test.js';
import { runWorkLeaseTests } from 'lib/work-leases.test.js';
import { runWorkerTransportTests } from 'lib/worker-transport.test.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  const [orchestration, leases, workerTransport] = await Promise.all([
    runOrchestrationTests(),
    runWorkLeaseTests(),
    runWorkerTransportTests(),
  ]);
  const ok = orchestration.ok && leases.ok && workerTransport.ok;
  return res.status(ok ? 200 : 500).json({
    ok,
    suites: { orchestration, leases, worker_transport: workerTransport },
    passed: orchestration.passed + leases.passed + workerTransport.passed,
    failed: orchestration.failed + leases.failed + workerTransport.failed,
  });
}