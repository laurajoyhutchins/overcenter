import { runRegressionVerification } from 'lib/regression-verification.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (_req, res) {
  try {
    const result = await runRegressionVerification();
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      schema: 'regression-verification-v1',
      runner_error: true,
      error: 'REGRESSION_VERIFICATION_EXECUTION_FAILED',
      message: String(error?.message || error || 'Regression verification runner failed'),
    });
  }
}