import { applyLinearMaintenance } from 'lib/linear-maintenance.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    const result = await applyLinearMaintenance(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    const code = String(error?.code || 'LINEAR_MAINTENANCE_FAILED');
    const status = code.includes('INVALID_') ? 422 : code.includes('INDETERMINATE') ? 503 : 502;
    return res.status(status).json({ ok: false, error: code, message: String(error?.message || code), details: error?.details || null });
  }
}