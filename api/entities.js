import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresPortfolioService } from 'lib/store.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  try {
    const entities = await createPostgresPortfolioService(db).listEntities({
      entityType: req.query?.entity_type || null,
      limit: req.query?.limit,
    });
    return res.json({ schema: 'portfolio-entity-list-v1', mode: 'shadow', count: entities.length, entities });
  } catch (error) {
    return sendError(res, error);
  }
}