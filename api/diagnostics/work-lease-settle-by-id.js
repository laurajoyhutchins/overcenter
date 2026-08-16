import { db } from 'hatchable';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function handler(req, res) {
  const leaseId = String(req.body?.lease_id || '').trim();
  const idempotencyKey = String(req.body?.idempotency_key || '').trim();
  if (!leaseId || !idempotencyKey) return res.status(400).json({ ok: false, error: 'REQUEST_INVALID' });

  const { rows } = await db.query('SELECT lease_token FROM work_leases WHERE lease_id = $1', [leaseId]);
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'LEASE_INVALID' });

  try {
    const receipt = await createPostgresWorkLeaseService().settle({
      lease_token: rows[0].lease_token,
      disposition: 'requeue',
      idempotency_key: idempotencyKey,
      evidence: [],
    });
    return res.json(receipt);
  } catch (error) {
    return res.status(statusForWorkLeaseError(error)).json({
      ok: false,
      error: String(error?.code || 'WORK_LEASE_ERROR'),
      message: String(error?.message || error),
    });
  }
}