import { verifyRepositoryRetirement, statusForRepositoryDisposalError } from 'lib/repository-disposal.js';

export const access = 'admin';
export const methods = ['GET', 'POST'];

export default async function (req, res) {
  try {
    const repository = String(req.body?.repository || req.query?.repository || '').trim();
    const result = await verifyRepositoryRetirement(repository);
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    return res.status(statusForRepositoryDisposalError(error)).json({ ok: false, error: { code: error?.code || 'INTERNAL_ERROR', message: String(error?.message || error), details: error?.details || null } });
  }
}