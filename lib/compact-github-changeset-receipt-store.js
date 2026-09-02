import { canonicalJson, sha256Text } from './canonical-json.js';
import { createCompactProviderOperationPostgresStore } from './compact-provider-operation-store.js';

const COMMAND = 'github.apply_changeset';
const STALE_CLAIM_SECONDS = 30;

function scope(normalized) {
  return `repository:${String(normalized?.repo || '')}`;
}

function payload(operation) {
  return operation?.recovery_payload && typeof operation.recovery_payload === 'object'
    ? operation.recovery_payload
    : {};
}

function resolution(operation) {
  return operation?.resolution && typeof operation.resolution === 'object'
    ? operation.resolution
    : {};
}

function compatibilityRow(operation) {
  if (!operation) return null;
  const recovery = payload(operation);
  const resolved = resolution(operation);
  const state = operation.state === 'indeterminate'
    ? 'prepared'
    : operation.state === 'prepared'
      ? 'processing'
      : operation.state;
  return Object.freeze({
    repo:recovery.repo || null,
    idempotency_key:operation.idempotency_key,
    request_sha256:operation.request_sha256,
    state,
    attempt_token:recovery.attempt_token || null,
    branch:recovery.branch || null,
    base_sha:recovery.base_sha || null,
    old_head:recovery.old_head || null,
    created_branch:Boolean(recovery.created_branch),
    precondition_verified:Boolean(recovery.precondition_verified),
    changed_paths:recovery.changed_paths || [],
    tree_sha:recovery.tree_sha || null,
    commit_sha:recovery.commit_sha || null,
    receipt:resolved.receipt || null,
    updated_at:operation.updated_at || null,
  });
}

function staleBefore(nowText) {
  const milliseconds = Date.parse(nowText);
  return new Date(milliseconds - STALE_CLAIM_SECONDS * 1000).toISOString();
}

export function createCompactGithubChangesetReceiptStore(dbBinding, options = {}) {
  const operations = createCompactProviderOperationPostgresStore(dbBinding);
  const now = options.now || (() => new Date().toISOString());
  const runId = options.runId || null;

  async function current(normalized) {
    return operations.get(COMMAND, scope(normalized), normalized.idempotency_key);
  }

  async function updateRecovery(normalized, attemptToken, patch) {
    const operation = await current(normalized);
    if (!operation) return null;
    return operations.updateRecovery({
      command:COMMAND,
      scope:scope(normalized),
      idempotency_key:normalized.idempotency_key,
      attempt_token:attemptToken,
      updated_at:now(),
      recovery_payload:{ ...payload(operation), ...patch },
    });
  }

  return Object.freeze({
    async claim(normalized, digest, attemptToken) {
      const observedAt = now();
      const claim = await operations.claim({
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
          branch:normalized.branch,
          request_json:normalized,
          phase:'claim',
        },
      });
      const row = compatibilityRow(claim.operation);
      if (claim.outcome === 'claimed') return { kind:'claimed', row };
      if (claim.outcome === 'conflict') return { kind:'conflict', row };
      if (claim.outcome === 'terminal' || claim.outcome === 'indeterminate') return { kind:'existing', row };
      return { kind:'in_progress', row };
    },

    async savePlan(normalized, attemptToken, plan) {
      await updateRecovery(normalized, attemptToken, {
        phase:'planned',
        base_sha:plan.baseSha,
        old_head:plan.oldHead,
        created_branch:Boolean(plan.createdBranch),
        precondition_verified:Boolean(plan.preconditionVerified),
        changed_paths:plan.changedPaths,
      });
    },

    async heartbeat(normalized, attemptToken, phase) {
      await operations.heartbeat({
        command:COMMAND,
        scope:scope(normalized),
        idempotency_key:normalized.idempotency_key,
        attempt_token:attemptToken,
        updated_at:now(),
        phase,
      });
    },

    async saveTree(normalized, attemptToken, treeSha) {
      await updateRecovery(normalized, attemptToken, { phase:'tree_created', tree_sha:treeSha });
    },

    async saveCommit(normalized, attemptToken, commitSha) {
      const operation = await current(normalized);
      if (!operation) return;
      await operations.markIndeterminate({
        command:COMMAND,
        scope:scope(normalized),
        idempotency_key:normalized.idempotency_key,
        attempt_token:attemptToken,
        updated_at:now(),
        recovery_payload:{ ...payload(operation), phase:'commit_created', commit_sha:commitSha },
      });
    },

    async succeed(normalized, receipt) {
      const operation = await current(normalized);
      if (!operation) return;
      const attemptToken = payload(operation).attempt_token;
      if (!attemptToken) return;
      const digest = await sha256Text(canonicalJson(receipt));
      await operations.succeed({
        command:COMMAND,
        scope:scope(normalized),
        idempotency_key:normalized.idempotency_key,
        attempt_token:attemptToken,
        updated_at:now(),
        effect_kind:'github_commit_branch',
        effect_ref:`${normalized.repo}#${receipt.branch}@${receipt.commit_sha}`,
        effect_sha256:digest,
        result_sha256:digest,
        resolution:{ receipt },
      });
    },

    async abandon(normalized, attemptToken) {
      await operations.abandon({
        command:COMMAND,
        scope:scope(normalized),
        idempotency_key:normalized.idempotency_key,
        attempt_token:attemptToken,
      });
    },
  });
}