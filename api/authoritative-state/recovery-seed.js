import { db } from 'hatchable';
import { captureGitHubRecoverySeed } from 'lib/authoritative-state-cutover.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    const result = await captureGitHubRecoverySeed({ db, ...(req.body || {}) });
    return res.status(200).json({ ok:true, ...result });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({
      ok:false,
      error:String(error?.code || 'CUTOVER_RECOVERY_SEED_FAILED'),
      message:String(error?.message || 'recovery seed capture failed'),
      may_have_mutated:false,
      ...(error?.details ? { details:error.details } : {}),
    });
  }
}