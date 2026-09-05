import { canonicalJson, sha256Text } from './canonical-json.js';
import { createCompactProviderOperationPostgresStore } from './compact-provider-operation-store.js';

const COMMAND = 'portfolio.reconcile_work_surface';
const SCOPE = 'portfolio:work-surface';
const STALE_CLAIM_SECONDS = 30;
const INITIAL_PROGRESS = Object.freeze({
  version:'portfolio-reconcile-progress-v1',
  may_have_mutated:false,
  items:[],
});

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function recovery(operation) {
  return object(operation?.recovery_payload);
}

function resolved(operation) {
  return object(operation?.resolution);
}

function staleBefore(nowText) {
  return new Date(Date.parse(nowText) - STALE_CLAIM_SECONDS * 1000).toISOString();
}

function ownershipError(key) {
  return Object.assign(
    new Error('reconciliation receipt ownership was lost before a durable effect boundary'),
    { code:'IDEMPOTENCY_IN_PROGRESS', details:{ idempotency_key:key } },
  );
}

export function createCompactPortfolioReconcileReceiptStore(dbBinding, options = {}) {
  const operations = createCompactProviderOperationPostgresStore(dbBinding);
  const now = options.now || (() => new Date().toISOString());
  const runId = options.runId || null;
  const activeAttempts = new Map();

  async function current(key) {
    return operations.get(COMMAND, SCOPE, key);
  }

  async function owned(key, hash) {
    const attemptToken = activeAttempts.get(key);
    if (!attemptToken) return null;
    const operation = await current(key);
    if (!operation || operation.request_sha256 !== hash) return null;
    if (recovery(operation).attempt_token !== attemptToken) return null;
    return { operation, attemptToken };
  }

  return Object.freeze({
    async claim(key, hash) {
      const observedAt = now();
      const attemptToken = crypto.randomUUID();
      const claim = await operations.claim({
        command:COMMAND,
        scope:SCOPE,
        idempotency_key:key,
        request_sha256:hash,
        attempt_token:attemptToken,
        created_at:observedAt,
        stale_before:staleBefore(observedAt),
        run_id:runId,
        recovery_payload:{ phase:'pre_effect', progress:INITIAL_PROGRESS },
      });

      if (claim.outcome === 'conflict') return { kind:'conflict' };
      if (claim.outcome === 'terminal') {
        if (claim.operation?.state === 'succeeded' && resolved(claim.operation).receipt) {
          return { kind:'existing', receipt:resolved(claim.operation).receipt };
        }
        return { kind:'in_progress' };
      }
      if (claim.outcome === 'indeterminate') {
        const prior = recovery(claim.operation);
        const priorAttemptToken = prior.attempt_token;
        if (!priorAttemptToken) return { kind:'in_progress' };
        const resumed = await operations.resumeIndeterminate({
          command:COMMAND,
          scope:SCOPE,
          idempotency_key:key,
          request_sha256:hash,
          prior_attempt_token:priorAttemptToken,
          attempt_token:attemptToken,
          updated_at:observedAt,
          recovery_payload:{
            phase:'recovery',
            progress:prior.progress || INITIAL_PROGRESS,
            last_error:prior.last_error || null,
          },
        });
        if (!resumed) return { kind:'in_progress' };
        activeAttempts.set(key, attemptToken);
        const resumedRecovery = recovery(resumed);
        return {
          kind:'recover',
          progress:resumedRecovery.progress || INITIAL_PROGRESS,
          last_error:resumedRecovery.last_error || null,
        };
      }
      if (claim.outcome === 'claimed') {
        activeAttempts.set(key, attemptToken);
        const progress = recovery(claim.operation).progress || INITIAL_PROGRESS;
        return { kind:'claimed', progress };
      }
      return { kind:'in_progress' };
    },

    async checkpoint(key, hash, phase, progress) {
      const owner = await owned(key, hash);
      if (!owner) throw ownershipError(key);
      const payload = {
        ...recovery(owner.operation),
        phase,
        progress,
      };
      let updated;
      if (progress?.may_have_mutated === true) {
        updated = await operations.markIndeterminate({
          command:COMMAND,
          scope:SCOPE,
          idempotency_key:key,
          attempt_token:owner.attemptToken,
          updated_at:now(),
          recovery_payload:payload,
        });
      } else {
        updated = await operations.updateRecovery({
          command:COMMAND,
          scope:SCOPE,
          idempotency_key:key,
          attempt_token:owner.attemptToken,
          updated_at:now(),
          recovery_payload:payload,
        });
      }
      if (!updated) throw ownershipError(key);
    },

    async markIndeterminate(key, hash, progress, error) {
      const owner = await owned(key, hash);
      if (!owner) return;
      await operations.markIndeterminate({
        command:COMMAND,
        scope:SCOPE,
        idempotency_key:key,
        attempt_token:owner.attemptToken,
        updated_at:now(),
        recovery_payload:{
          ...recovery(owner.operation),
          phase:'indeterminate',
          progress,
          last_error:error || {},
        },
      });
    },

    async succeed(key, hash, receipt, progress = null) {
      const owner = await owned(key, hash);
      if (!owner) throw ownershipError(key);
      const digest = await sha256Text(canonicalJson(receipt));
      const updated = await operations.succeed({
        command:COMMAND,
        scope:SCOPE,
        idempotency_key:key,
        attempt_token:owner.attemptToken,
        updated_at:now(),
        effect_kind:'portfolio_work_surface_reconcile',
        effect_ref:`portfolio-reconcile:${key}`,
        effect_sha256:digest,
        result_sha256:digest,
        resolution:{ receipt, progress },
      });
      activeAttempts.delete(key);
      if (!updated) throw ownershipError(key);
    },

    async abandon(key, hash) {
      const owner = await owned(key, hash);
      if (!owner) {
        activeAttempts.delete(key);
        return;
      }
      await operations.abandon({
        command:COMMAND,
        scope:SCOPE,
        idempotency_key:key,
        attempt_token:owner.attemptToken,
      });
      activeAttempts.delete(key);
    },
  });
}