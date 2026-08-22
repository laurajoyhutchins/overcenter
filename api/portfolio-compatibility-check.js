import { createPostgresRepositoryLifecycleService, statusForRepositoryDispositionError } from 'lib/repository-disposition.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    return res.json(await createPostgresRepositoryLifecycleService().checkCompatibility(req.body || {}));
  } catch (error) {
    return res.status(statusForRepositoryDispositionError(error)).json({ ok: false, error: { code: error?.code || 'INTERNAL_ERROR', message: String(error?.message || error), details: error?.details || null } });
  }
}