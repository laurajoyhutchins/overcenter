import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresPortfolioService, limits } from 'lib/store.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const observations = Array.isArray(body.observations) ? body.observations : [];
  if (observations.length < 1 || observations.length > limits.max_batch) {
    return res.status(400).json({
      schema: 'portfolio-reconciler-error-v1',
      error: 'OBSERVATION_BATCH_INVALID',
      message: `observations must contain 1-${limits.max_batch} entries`,
    });
  }
  try {
    const service = createPostgresPortfolioService(db);
    const result = await service.ingestObservations(observations, {
      ingestionSource: body.ingestion_source || 'chatgpt-shadow-reconciler',
      ingestionRunId: body.ingestion_run_id || null,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
}