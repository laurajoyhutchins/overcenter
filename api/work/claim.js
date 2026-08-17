import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'work.claim',
    req.body || {},
    (input) => createPostgresWorkLeaseService().claim(input),
    {
      statusForFailure: statusForWorkLeaseError,
      defaultError: 'WORK_CLAIM_ERROR',
      defaultMessage: 'work.claim failed',
      flattenDetails: true,
    },
  );
  return res.status(response.status).json(response.body);
}