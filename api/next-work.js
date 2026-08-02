import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  try {
    const result = await createPostgresWorkService(db).getNextWork({
      route: req.query?.route || null,
      repository: req.query?.repository || null,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
}