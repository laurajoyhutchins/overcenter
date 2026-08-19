import { commandFailure } from 'lib/command-response.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const command = typeof req.body?.command === 'string' ? req.body.command : '';
  const input = req.body?.input;
  if (!command) {
    const response = commandFailure('work.claim', {
      code: 'REQUEST_INVALID',
      message: 'command is required',
      details: { field: 'command' },
    }, { flattenDetails: true, http_status: 400 });
    return res.status(response.status).json(response.body);
  }
  const response = await executeSemanticWorkerCommand(command, input);
  return res.status(response.status).json(response.body);
}