import pg from 'pg';

import { resolveCloudRunConfig } from './cloud-run-host.mjs';
import { activateAuthoritativeTarget } from './cloud-run-target-authority.mjs';

const config = resolveCloudRunConfig(process.env);
const { Pool } = pg;
const pool = new Pool(config.postgres);

function classifiedExitCode(error) {
  if (error?.code === '42501') return 13; // PostgreSQL insufficient_privilege
  if (error?.code === '55000') return 14; // frozen-source rejection / object state
  if (String(error?.code || '').startsWith('TARGET_ACTIVATION_')) return 15;
  return 1;
}

try {
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
    message:error?.message || 'authoritative target activation failed',
    details:error?.details || null,
    may_have_mutated:error?.may_have_mutated === true,
  }));
  process.exitCode = classifiedExitCode(error);
} finally {
  await pool.end();
}
