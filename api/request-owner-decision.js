import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';
export const methods = ['POST'];

function bodyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export default async function (req, res) {
  const body = bodyObject(req.body);
  try {
    const result = await createPostgresWorkService(db).requestOwnerDecision({
      entityKey: body.entityKey ?? body.entity_key,
      expectedRevision: body.expectedRevision ?? body.expected_revision,
      idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
      category: body.category,
      summary: body.summary,
      recommendedAction: body.recommendedAction ?? body.recommended_action,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
}