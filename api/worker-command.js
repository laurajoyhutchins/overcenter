import { commandFailure } from 'lib/command-response.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';

export const access = 'admin';
export const methods = ['POST'];

function safeInputShape(input) {
  if (Array.isArray(input)) return { input_type: 'array' };
  if (!input || typeof input !== 'object') return { input_type: input === null ? 'null' : typeof input };
  const shape = {};
  for (const key of Object.keys(input).sort().slice(0, 20)) {
    const value = input[key];
    shape[key] = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
  }
  return shape;
}

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
  if (response.status >= 400) {
    console.warn(JSON.stringify({
      event: 'worker_command_rejected',
      command,
      error: response.body?.error || null,
      field: response.body?.field || response.body?.details?.field || null,
      input_shape: safeInputShape(input),
    }));
  }
  return res.status(response.status).json(response.body);
}