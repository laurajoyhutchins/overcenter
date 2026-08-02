import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  try {
    const result = await createPostgresWorkService(db).search({
      query: req.query?.query || null,
      repository: req.query?.repository || null,
      lifecycle: req.query?.lifecycle || null,
      route: req.query?.route || null,
      sourceType: req.query?.source_type || null,
      limit: req.query?.limit,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
}