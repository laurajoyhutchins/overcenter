import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresPortfolioService } from 'lib/store.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  try {
    const entities = await createPostgresPortfolioService(db).listOwnerDecisions();
    const decisions = entities.flatMap((entity) =>
      entity.owner_action.decisions.map((decision) => ({
        entity_key: entity.entity_key,
        entity_type: entity.entity_type,
        projection_revision: entity.projection_sha256,
        source_revisions: entity.source_revisions,
        discrepancies: entity.discrepancies,
        next_action: entity.next_action,
        ...decision,
      }))
    );
    return res.json({
      schema: 'portfolio-owner-decision-queue-v2',
      mode: 'shadow',
      count: decisions.length,
      decisions,
      entities,
    });
  } catch (error) {
    return sendError(res, error);
  }
}