import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { orchestrationStatus } from 'lib/orchestration-status.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'orchestration.status',
    req.body || {},
    () => orchestrationStatus(),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}