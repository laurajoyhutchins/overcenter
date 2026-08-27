import { executeWorkClaimBoundary } from 'lib/work-claim-boundary.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const response = await executeWorkClaimBoundary(req.body || {});
  return res.status(response.status).json(response.body);
}