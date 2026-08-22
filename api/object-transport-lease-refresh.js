import { refreshObjectTransportLease } from 'lib/object-transport-lease.js';

export const access = 'scheduler';
export const methods = ['POST'];
export const schedule = '2 * * * *';

export default async function (_req, res) {
  try {
    res.json(await refreshObjectTransportLease());
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.code || 'OBJECT_TRANSPORT_LEASE_FAILED', message: String(error?.message || error), phase: error?.phase || null, status: error?.status || null });
  }
}