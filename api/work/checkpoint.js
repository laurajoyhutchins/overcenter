import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeSemanticWorkerCommand('work.checkpoint', req.body || {});
  return res.status(response.status).json(response.body);
}