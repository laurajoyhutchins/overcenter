import pg from 'pg';

import { resolveCloudRunConfig } from './cloud-run-host.mjs';
import { activateAuthoritativeTarget } from './cloud-run-target-authority.mjs';

const config = resolveCloudRunConfig(process.env);
const { Pool } = pg;
const pool = new Pool(config.postgres);

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
  process.exitCode = 1;
} finally {
  await pool.end();
}
