import { canonicalJson, sha256Text } from './canonical-json.js';
import { createCompactProviderOperationPostgresStore } from './compact-provider-operation-store.js';

const COMMAND = 'github.release.create';
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
function compatibleRow(operation) {
  if (!operation) return null;
  const data = recovery(operation);
  return Object.freeze({
    repo:data.repo || null,
    idempotency_key:operation.idempotency_key,
    request_sha256:operation.request_sha256,
    state:operation.state === 'indeterminate' ? 'partial' : operation.state === 'prepared' ? 'processing' : operation.state,
    attempt_token:data.attempt_token || null,
    target_sha:data.target_sha || null,
    tag_name:data.tag_name || null,
    tag_created:Boolean(data.tag_created),
    tag_ref_node_id:data.tag_ref_node_id || null,
    release_may_exist:Boolean(data.release_may_exist),
    last_error:data.last_error || null,
    receipt:resolution(operation).receipt || null,
  });
}
function staleBefore(nowText) {
  return new Date(Date.parse(nowText) - STALE_CLAIM_SECONDS * 1000).toISOString();
}

export function createCompactGithubReleaseReceiptStore(dbBinding, options = {}) {
  const operations = createCompactProviderOperationPostgresStore(dbBinding);
  const now = options.now || (() => new Date().toISOString());
  const runId = options.runId || null;

  async function current(normalized) {
    return operations.get(COMMAND, scope(normalized), normalized.idempotency_key);
  }
  async function update(normalized, attemptToken, patch) {
    const operation = await current(normalized);
    if (!operation) return null;
    return operations.updateRecovery({
      command:COMMAND,
      scope:scope(normalized),
      idempotency_key:normalized.idempotency_key,
      attempt_token:attemptToken,
      updated_at:now(),
      recovery_payload:{ ...recovery(operation), ...patch },
    });
  }

  return Object.freeze({
    async claim(normalized, digest) {
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
          target_sha:normalized.target_sha,
          tag_name:normalized.tag_name,
          request_json:normalized,
          phase:'claim',
          tag_created:false,
          release_may_exist:false,
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
          recovery_payload:{ ...prior, phase:'resume' },
        });
        if (resumed) return { kind:'claimed', row:compatibleRow(resumed), attempt_token:attemptToken, resumed:true };
        claimed = await operations.claim({
          command:COMMAND, scope:scope(normalized), idempotency_key:normalized.idempotency_key,
          request_sha256:digest, attempt_token:attemptToken, created_at:observedAt,
          stale_before:staleBefore(observedAt), run_id:runId, recovery_payload:{ phase:'claim' },
        });
      }
      const row = compatibleRow(claimed.operation);
      if (claimed.outcome === 'claimed') return { kind:'claimed', row, attempt_token:attemptToken, ...(claimed.recovered ? { resumed:true } : {}) };
      if (claimed.outcome === 'conflict') return { kind:'conflict', row };
      if (claimed.outcome === 'terminal') return { kind:'existing', row };
      return { kind:'in_progress', row };
    },

    async markTag(normalized, attemptToken, evidence = {}) {
      await update(normalized, attemptToken, { phase:'tag_created', tag_created:true, ...(evidence.tag_ref_node_id ? { tag_ref_node_id:evidence.tag_ref_node_id } : {}) });
    },

    async markPartial(normalized, attemptToken, details = {}) {
      const operation = await current(normalized);
      if (!operation) return;
      const data = recovery(operation);
      await operations.markIndeterminate({
        command:COMMAND,
        scope:scope(normalized),
        idempotency_key:normalized.idempotency_key,
        attempt_token:attemptToken,
        updated_at:now(),
        recovery_payload:{
          ...data,
          phase:'partial',
          release_may_exist:Boolean(data.release_may_exist || details.release_may_exist),
          last_error:String(details.error || 'partial release mutation'),
        },
      });
    },

    async abandon(normalized, attemptToken) {
      await operations.abandon({ command:COMMAND, scope:scope(normalized), idempotency_key:normalized.idempotency_key, attempt_token:attemptToken });
    },

    async succeed(normalized, attemptToken, receipt) {
      const digest = await sha256Text(canonicalJson(receipt));
      await operations.succeed({
        command:COMMAND,
        scope:scope(normalized),
        idempotency_key:normalized.idempotency_key,
        attempt_token:attemptToken,
        updated_at:now(),
        may_have_mutated:Boolean(receipt?.created),
        effect_kind:'github_release',
        effect_ref:`${normalized.repo}#${normalized.tag_name}${receipt?.release_id ? `:${receipt.release_id}` : ''}`,
        effect_sha256:digest,
        result_sha256:digest,
        resolution:{ receipt },
      });
    },
  });
}