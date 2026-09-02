import { canonicalJson, sha256Text } from './canonical-json.js';
import { createCompactProviderOperationPostgresStore } from './compact-provider-operation-store.js';

const COMMAND = 'github.production.promote';
const STALE_CLAIM_SECONDS = 30;

function scope(normalized) {
  return `repository:${String(normalized?.repo || '')}`;
}
function recovery(operation) {
  return operation?.recovery_payload && typeof operation.recovery_payload === 'object' ? operation.recovery_payload : {};
}
function resolution(operation) {
  return operation?.resolution && typeof operation.resolution === 'object' ? operation.resolution : {};
}
function row(operation) {
  if (!operation) return null;
  const data = recovery(operation);
  return Object.freeze({
    repo:data.repo || null,
    idempotency_key:operation.idempotency_key,
    request_sha256:operation.request_sha256,
    state:operation.state === 'indeterminate' ? 'unclear' : operation.state === 'prepared' ? 'processing' : operation.state,
    attempt_token:data.attempt_token || null,
    candidate_sha:data.candidate_sha || null,
    old_production_head:data.old_production_head || null,
    verification_run_id:data.verification_run_id || null,
    receipt:resolution(operation).receipt || null,
  });
}
function staleBefore(nowText) {
  return new Date(Date.parse(nowText) - STALE_CLAIM_SECONDS * 1000).toISOString();
}

export function createCompactGithubProductionPromotionReceiptStore(dbBinding, options = {}) {
  const operations = createCompactProviderOperationPostgresStore(dbBinding);
  const now = options.now || (() => new Date().toISOString());
  const runId = options.runId || null;
  const activeAttempts = new Map();
  const keyFor = (normalized) => `${scope(normalized)}:${normalized.idempotency_key}`;

  async function claim(normalized, digest) {
    const attemptToken = crypto.randomUUID();
    const observedAt = now();
    let claimed = await operations.claim({
      command:COMMAND,
      scope:scope(normalized),
      idempotency_key:normalized.idempotency_key,
      request_sha256:digest,
      attempt_token:attemptToken,
      created_at:observedAt,
      stale_before:staleBefore(observedAt),
      run_id:runId,
      recovery_payload:{
        repo:normalized.repo,
        candidate_sha:normalized.candidate_sha,
        old_production_head:normalized.observed_production_head,
        verification_run_id:normalized.verification_run_id,
        request_json:normalized,
        phase:'claim',
      },
    });
    if (claimed.outcome === 'indeterminate') {
      const prior = recovery(claimed.operation);
      const resumed = await operations.resumeIndeterminate({
        command:COMMAND,
        scope:scope(normalized),
        idempotency_key:normalized.idempotency_key,
        request_sha256:digest,
        prior_attempt_token:prior.attempt_token,
        attempt_token:attemptToken,
        updated_at:observedAt,
        recovery_payload:{ ...prior, phase:'reconcile_uncertain_promotion' },
      });
      if (resumed) {
        activeAttempts.set(keyFor(normalized), attemptToken);
        return { kind:'claimed', row:row(resumed), attempt_token:attemptToken, resumed:true };
      }
      claimed = await operations.claim({
        command:COMMAND,
        scope:scope(normalized),
        idempotency_key:normalized.idempotency_key,
        request_sha256:digest,
        attempt_token:attemptToken,
        created_at:observedAt,
        stale_before:staleBefore(observedAt),
        run_id:runId,
        recovery_payload:{ phase:'claim' },
      });
    }
    const compatible = row(claimed.operation);
    if (claimed.outcome === 'claimed') {
      activeAttempts.set(keyFor(normalized), attemptToken);
      return { kind:'claimed', row:compatible, attempt_token:attemptToken, ...(claimed.recovered ? { resumed:true } : {}) };
    }
    if (claimed.outcome === 'conflict') return { kind:'conflict', row:compatible };
    if (claimed.outcome === 'terminal') return { kind:'existing', row:compatible };
    return { kind:'in_progress', row:compatible };
  }

  async function markMutationBoundary(normalized) {
    const attemptToken = activeAttempts.get(keyFor(normalized));
    if (!attemptToken) return null;
    const operation = await operations.get(COMMAND, scope(normalized), normalized.idempotency_key);
    if (!operation) return null;
    return operations.markIndeterminate({
      command:COMMAND,
      scope:scope(normalized),
      idempotency_key:normalized.idempotency_key,
      attempt_token:attemptToken,
      updated_at:now(),
      recovery_payload:{ ...recovery(operation), phase:'production_ref_update_dispatched' },
    });
  }

  async function abandon(normalized, attemptToken) {
    activeAttempts.delete(keyFor(normalized));
    await operations.abandon({ command:COMMAND, scope:scope(normalized), idempotency_key:normalized.idempotency_key, attempt_token:attemptToken });
  }

  async function succeed(normalized, attemptToken, receipt) {
    const digest = await sha256Text(canonicalJson(receipt));
    const settled = await operations.succeed({
      command:COMMAND,
      scope:scope(normalized),
      idempotency_key:normalized.idempotency_key,
      attempt_token:attemptToken,
      updated_at:now(),
      may_have_mutated:Boolean(receipt?.changed || receipt?.recovered_after_uncertain_mutation),
      effect_kind:'github_production_promotion',
      effect_ref:`${normalized.repo}#${receipt.production_branch}@${receipt.new_production_head}`,
      effect_sha256:digest,
      result_sha256:digest,
      resolution:{ receipt },
    });
    activeAttempts.delete(keyFor(normalized));
    if (!settled) {
      throw Object.assign(new Error('production promotion compact operation settlement lost attempt-token authority'), {
        code:'GITHUB_PRODUCTION_PROMOTION_RECEIPT_FENCE_LOST',
        details:{ repo:normalized.repo, idempotency_key:normalized.idempotency_key },
      });
    }
    return settled;
  }

  return Object.freeze({ claim, abandon, succeed, markMutationBoundary });
}