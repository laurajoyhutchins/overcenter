import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    return res.json(await createPostgresWorkLeaseService().claim(req.body || {}));
  } catch (error) {
    return res.status(statusForWorkLeaseError(error)).json({
      ok: false,
      error: String(error?.code || 'WORK_CLAIM_ERROR'),
      message: String(error?.message || 'work.claim failed'),
      ...(error?.details || {}),
    });
  }
}