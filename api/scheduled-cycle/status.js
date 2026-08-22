import { createPostgresScheduledCycleService, statusForScheduledCycleError } from 'lib/scheduled-cycle-completeness.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (req, res) {
  try {
    const result = await createPostgresScheduledCycleService().status({ cycle_id:req.query?.cycle_id, observed_at:req.query?.observed_at });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(statusForScheduledCycleError(error)).json({ ok:false, error:String(error?.code || 'SCHEDULED_CYCLE_ERROR'), message:String(error?.message || 'scheduled-cycle status failed'), details:error?.details || null });
  }
}