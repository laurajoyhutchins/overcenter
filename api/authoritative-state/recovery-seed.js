import { db } from 'hatchable';
import { hatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { canonicalJson } from 'lib/canonical-json.js';
import { captureGitHubRecoverySeed } from 'lib/authoritative-state-cutover.js';
import { PROJECT_TRANSITION_RECOVERY_SEED_PATH } from 'lib/project-transition-github-recovery.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function (req, res) {
  try {
    const body = req.body || {};
    const { lease_ref:leaseRef, commit = false, ...captureInput } = body;
    const result = await captureGitHubRecoverySeed({ db, ...captureInput });
    if (commit !== true) return res.status(200).json({ ok:true, ...result });
    if (typeof leaseRef !== 'string' || !leaseRef.trim()) {
      return res.status(422).json({ ok:false, error:'CUTOVER_LEASE_REQUIRED', message:'lease_ref is required to commit the recovery seed', may_have_mutated:false });
    }
    const mutation = await executeSemanticWorkerCommand('github.apply_changeset', {
      lease_ref:leaseRef.trim(),
      changes:[{
        path:PROJECT_TRANSITION_RECOVERY_SEED_PATH,
        operation:'create',
        content:canonicalJson(result.seed),
        ensure_final_newline:true,
      }],
      commit_message:'cutover: seal Hatchable recovery seed',
    }, { ...hatchableRuntimeProviders, logger:console });
    if (mutation?.body?.ok !== true) {
      return res.status(Number(mutation?.status || 409)).json({ ...mutation.body, recovery_seed_digest:result.digest });
    }
    return res.status(200).json({
      ok:true,
      ...result,
      recovery_seed_path:PROJECT_TRANSITION_RECOVERY_SEED_PATH,
      mutation:mutation.body,
    });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({
      ok:false,
      error:String(error?.code || 'CUTOVER_RECOVERY_SEED_FAILED'),
      message:String(error?.message || 'recovery seed capture failed'),
      may_have_mutated:Boolean(error?.mayHaveMutated),
      ...(error?.details ? { details:error.details } : {}),
    });
  }
}
