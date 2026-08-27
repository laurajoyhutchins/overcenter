import { executeWorkSettleBoundary } from 'lib/work-settle-boundary.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeWorkSettleBoundary(req.body || {});
  return res.status(response.status).json(response.body);
}
