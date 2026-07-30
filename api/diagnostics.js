import { db } from 'hatchable';
import { runDiagnostics } from 'lib/diagnostics.js';
import { sendError } from 'lib/http.js';

export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  try {
    const result = await runDiagnostics(db);
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    return sendError(res, error);
  }
}