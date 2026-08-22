import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand('work.heartbeat', req.body || {}, (input) => createPostgresWorkLeaseService().heartbeat(input), workerBoundaryFailureOptions('work.heartbeat', {
    statusForFailure: statusForWorkLeaseError,
    defaultError: 'WORK_HEARTBEAT_ERROR',
    defaultMessage: 'work.heartbeat failed',
    flattenDetails: true,
  }));
  return res.status(response.status).json(response.body);
}