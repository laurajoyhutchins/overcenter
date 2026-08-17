import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { orchestrationResumePacket } from 'lib/orchestration-recovery.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeCorrelatedCommand(
    'orchestration.resume_packet',
    req.body || {},
    (input) => orchestrationResumePacket(input),
    { flattenDetails: true },
  );
  return res.status(response.status).json(response.body);
}