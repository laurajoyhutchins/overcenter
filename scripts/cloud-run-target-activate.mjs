import pg from 'pg';

import { resolveCloudRunConfig } from './cloud-run-host.mjs';
import { classifiedActivationExitCode } from './cloud-run-target-activation-exit.mjs';
import { activateAuthoritativeTarget } from './cloud-run-target-authority.mjs';

let pool = null;

try {
  const config = resolveCloudRunConfig(process.env);
  const { Pool } = pg;
  pool = new Pool(config.postgres);

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
  process.exitCode = classifiedActivationExitCode(error);
} finally {
  if (pool) {
    await pool.end().catch(error => {
      console.error(JSON.stringify({
        ok:false,
        warning:'TARGET_ACTIVATION_POOL_CLEANUP_FAILED',
        error:error?.code || null,
        message:error?.message || 'PostgreSQL pool cleanup failed after target activation attempt',
      }));
    });
  }
}
