import { executeCommand } from 'lib/command-response.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCommand(
    'work.settle',
    () => createPostgresWorkLeaseService().settle(req.body || {}),
    {
      statusForFailure: statusForWorkLeaseError,
      defaultError: 'WORK_SETTLE_ERROR',
      defaultMessage: 'work.settle failed',
      flattenDetails: true,
    },
  );
  return res.status(response.status).json(response.body);
}