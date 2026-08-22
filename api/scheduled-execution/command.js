import { createPostgresScheduledExecutionContextService, statusForScheduledExecutionContextError } from 'lib/scheduled-execution-context.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    const result = await createPostgresScheduledExecutionContextService().execute(req.body || {});
    return res.status(result.ok === false ? Number(result.http_status || 409) : 200).json(result);
  } catch (error) {
    return res.status(statusForScheduledExecutionContextError(error)).json({
      ok:false,
      error:String(error?.code || 'SCHEDULED_EXECUTION_ERROR'),
      message:String(error?.message || 'scheduled execution command failed'),
      details:error?.details || null,
    });
  }
}
