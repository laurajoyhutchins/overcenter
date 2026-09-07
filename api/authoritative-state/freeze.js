import { db } from 'hatchable';
import { freezeSourceAtRecoveryCoordinates } from 'lib/authoritative-state-cutover.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    const freeze = await freezeSourceAtRecoveryCoordinates({ db, ...(req.body || {}) });
    return res.status(200).json({ ok:true, freeze });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({
      ok:false,
      error:String(error?.code || 'CUTOVER_FREEZE_FAILED'),
      message:String(error?.message || 'source freeze failed'),
      may_have_mutated:Boolean(error?.mayHaveMutated),
      ...(error?.details ? { details:error.details } : {}),
    });
  }
}