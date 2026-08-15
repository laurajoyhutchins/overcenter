import { archiveLinearIssue } from 'lib/linear-archive.js';

export const access = 'admin';
export const methods = ['POST'];

function isSetupRequired(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === 'SetupRequired'
    || Number(error?.status || error?.statusCode || error?.httpStatus) === 412
    || (message.includes('412') && message.includes('API "linear" is not connected'));
}

function statusFor(error) {
  const code = String(error?.code || 'LINEAR_ARCHIVE_ERROR');
  if (isSetupRequired(error)) return 412;
  if (code.includes('INVALID')) return 400;
  if (code.includes('NOT_FOUND')) return 404;
  if (code.includes('NOT_TERMINAL') || code.includes('NOT_CONFIRMED')) return 409;
  if (code.includes('UPSTREAM')) return 502;
  return 500;
}

export default async function (req, res) {
  try {
    const result = await archiveLinearIssue({
      issue: req.body?.issue,
      dryRun: req.body?.dry_run === true,
    });
    return res.json(result);
  } catch (error) {
    const setupRequired = isSetupRequired(error);
    return res.status(statusFor(error)).json({
      ok: false,
      action: 'archive_linear_issue',
      error: setupRequired ? 'LINEAR_SETUP_REQUIRED' : String(error?.code || 'LINEAR_ARCHIVE_ERROR'),
      message: setupRequired
        ? 'Connect the Linear API in the Portfolio Control Plane Hatchable Setup page.'
        : String(error?.message || 'Linear archival failed'),
      details: setupRequired ? null : (error?.details || null),
    });
  }
}