import { db } from 'hatchable';
import { sendError } from 'lib/http.js';
import { createPostgresPortfolioService } from 'lib/store.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  try {
    const status = await createPostgresPortfolioService(db).getStatus();
    return res.json({ schema: 'portfolio-reconciler-status-v1', mode: 'shadow', ...status });
  } catch (error) {
    return sendError(res, error);
  }
}