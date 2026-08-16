import { createPostgresLeaseStore, createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    const lease = await createPostgresLeaseStore().getLeaseById(String(req.body?.lease_id || ''));
    if (!lease) return res.status(404).json({ ok: false, error: 'LEASE_NOT_FOUND' });
    const result = await createPostgresWorkLeaseService().settle({
      lease_token: lease.lease_token,
      disposition: req.body?.disposition,
      evidence: req.body?.evidence || [],
      reason: req.body?.reason ?? null,
      promotion_condition: req.body?.promotion_condition ?? null,
      idempotency_key: req.body?.idempotency_key,
    });
    return res.json(result);
  } catch (error) {
    return res.status(statusForWorkLeaseError(error)).json({
      ok: false,
      error: String(error?.code || 'WORK_SETTLE_ERROR'),
      message: String(error?.message || 'verification settle failed'),
      ...(error?.details || {}),
    });
  }
}