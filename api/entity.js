import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  try {
    const projection = await createPostgresWorkService(db).fetch({
      entityKey: req.query?.entity_key,
    });
    return res.json({
      schema: 'portfolio-entity-response-v1',
      entity: projection,
      revision: projection.projection_sha256,
    });
  } catch (error) {
    return sendError(res, error);
  }
}