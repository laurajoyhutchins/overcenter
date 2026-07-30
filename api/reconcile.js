import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresPortfolioService } from 'lib/store.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  try {
    const service = createPostgresPortfolioService(db);
    const result = await service.reconcileEntities({
      mode: 'shadow',
      entityKeys: Array.isArray(body.entity_keys) ? body.entity_keys : null,
      limit: body.limit,
    });
    return res.json({ schema: 'portfolio-reconciliation-result-v1', ...result });
  } catch (error) {
    return sendError(res, error);
  }
}