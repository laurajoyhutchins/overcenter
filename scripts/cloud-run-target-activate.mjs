import pg from 'pg';

import { resolveCloudRunConfig } from './cloud-run-host.mjs';
import { activateAuthoritativeTarget } from './cloud-run-target-authority.mjs';

const PHASE_EXIT = Object.freeze({
  database_connect:19,
  begin:21,
  freeze_identity:22,
  source_fence_count_before:23,
  source_fence_dependencies:24,
  source_fence_drop:25,
  source_fence_count_after:26,
  commit:27,
});

function classifiedExitCode(error) {
  if (error?.code === '42501') return 13; // PostgreSQL insufficient_privilege
  if (error?.code === '55000') return 14; // frozen-source rejection / object state
  if (PHASE_EXIT[error?.activationPhase]) return PHASE_EXIT[error.activationPhase];
  if (String(error?.code || '').startsWith('TARGET_ACTIVATION_')) return 15;
  if (error?.code === 'POSTGRES_CONFIG_REQUIRED' || error?.code === 'AUTHORITY_MODE_INVALID') return 18;
  return 1;
}

let pool = null;
try {
  const config = resolveCloudRunConfig(process.env);
  const { Pool } = pg;
  pool = new Pool(config.postgres);

  try {
    await pool.query('SELECT 1 AS ok');
  } catch (error) {
    if (error && typeof error === 'object') error.activationPhase = 'database_connect';
    throw error;
  }

  const result = await activateAuthoritativeTarget({
    db:pool,
    authorityMode:config.authorityMode,
    sourceRevision:process.env.OVERCENTER_SOURCE_REVISION,
    sourceFreezeDigest:process.env.OVERCENTER_SOURCE_FREEZE_DIGEST,
  });
  if (result?.activated !== true || result?.source_freeze_triggers_remaining !== 0) {
    throw Object.assign(new Error('authoritative target activation did not prove a writable target'), {
      code:'TARGET_ACTIVATION_PROOF_REQUIRED',
      details:{ result:result || null, may_have_mutated:false },
      may_have_mutated:false,
    });
  }
  console.log(JSON.stringify({ ok:true, target_activation:result }));
} catch (error) {
  console.error(JSON.stringify({
    ok:false,
    error:error?.code || 'TARGET_ACTIVATION_FAILED',
    phase:error?.activationPhase || null,
    message:error?.message || 'authoritative target activation failed',
    details:error?.details || null,
    may_have_mutated:error?.may_have_mutated === true,
  }));
  process.exitCode = classifiedExitCode(error);
} finally {
  if (pool) await pool.end().catch(() => {});
}
