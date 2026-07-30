export function sendError(res, error) {
  const code = String(error?.code || 'PORTFOLIO_RECONCILER_ERROR');
  const status = code.includes('CONFLICT') ? 409
    : code.includes('INVALID') ? 400
      : 500;
  return res.status(status).json({
    schema: 'portfolio-reconciler-error-v1',
    error: code,
    message: String(error?.message || 'portfolio reconciliation failed'),
    details: error?.details || null,
  });
}