import { createPostgresScheduledExecutionContextService, statusForScheduledExecutionContextError } from 'lib/scheduled-execution-context.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    const result = await createPostgresScheduledExecutionContextService().bootstrap(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    return res.status(statusForScheduledExecutionContextError(error)).json({
      ok:false,
      error:String(error?.code || 'SCHEDULED_EXECUTION_CONTEXT_ERROR'),
      message:String(error?.message || 'scheduled execution bootstrap failed'),
      details:error?.details || null,
    });
  }
}
