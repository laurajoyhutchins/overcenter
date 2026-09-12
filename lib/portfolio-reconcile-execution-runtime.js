import { canonicalJson, sha256Text } from './canonical-json.js';
import { executePortfolioReconciliation } from './portfolio-reconcile-execution.js';
import { reconcilePortfolioWorkSurface } from './portfolio-reconcile-work-surface.js';

const SHA40 = /^[0-9a-f]{40}$/i;

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details, may_have_mutated: false });
}

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) fail('PORTFOLIO_EXECUTION_INVALID', field + ' is required', { field });
  return text;
}

function exactRevision(value, field) {
  const revision = requiredText(value, field).toLowerCase();
  if (!SHA40.test(revision)) {
    fail('PORTFOLIO_EXECUTION_INVALID', field + ' must be an exact Git revision', { field, revision });
  }
  return revision;
}

function authorityFor(options = {}) {
  const authority = options.authority;
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    fail('EXECUTION_AUTHORITY_REQUIRED', 'portfolio reconciliation requires the authoritative project graph coordinate');
  }
  const project_ref = requiredText(authority.project_ref, 'authority.project_ref');
  const repository = requiredText(authority.repository, 'authority.repository');
  const revision = exactRevision(authority.revision, 'authority.revision');
  const epoch = Number(authority.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    fail('EXECUTION_AUTHORITY_INVALID', 'authority.epoch must be a non-negative integer');
  }
  return Object.freeze({
    project_ref,
    repository,
    revision,
    epoch,
    graph_fingerprint: requiredText(authority.graph_fingerprint, 'authority.graph_fingerprint'),
    transition_fingerprint: requiredText(authority.transition_fingerprint, 'authority.transition_fingerprint'),
  });
}

function executionStoreFor(options = {}) {
  const store = options.executionTransactionStore;
  if (!store || typeof store.prepareExecution !== 'function') {
    fail('EXECUTION_TRANSACTION_STORE_REQUIRED', 'portfolio reconciliation requires the authoritative execution transaction store');
  }
  return store;
}

function providerInputFor(input, dryRun = input?.dry_run) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('PORTFOLIO_EXECUTION_INVALID', 'portfolio reconciliation input must be an object');
  }
  return {
    ...input,
    idempotency_key: null,
    ...(dryRun === undefined ? {} : { dry_run: Boolean(dryRun) }),
  };
}

function resultEvidence(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  return { result: String(result ?? '') };
}

function itemResults(result) {
  return Array.isArray(result?.items) ? result.items.map(item => String(item?.result || '')) : [];
}

function effectReference(authority, input, intent) {
  return `portfolio-reconcile:${authority.repository}:${input.project}:${intent.operation.idempotency_key}`;
}

async function invocationFacts(result, authority, input, intent) {
  const evidence = resultEvidence(result);
  const response_sha256 = await sha256Text(canonicalJson(evidence));
  if (result?.may_have_mutated === true || result?.error === 'PORTFOLIO_RECONCILE_INDETERMINATE') {
    return {
      transport: 'unknown',
      committed: null,
      effect_ref: null,
      response_sha256: null,
      evidence,
    };
  }
  if (result?.ok !== true) {
    return {
      transport: 'rejected',
      committed: false,
      effect_ref: null,
      response_sha256,
      evidence,
    };
  }
  const results = itemResults(result);
  const hasSatisfiedEffect = results.some(value => value === 'created' || value === 'updated' || value === 'reused');
  if (input.dry_run === true || !hasSatisfiedEffect) {
    return {
      transport: 'rejected',
      committed: false,
      effect_ref: null,
      response_sha256,
      evidence,
    };
  }
  return {
    transport: 'accepted',
    committed: true,
    effect_ref: effectReference(authority, input, intent),
    response_sha256,
    evidence,
  };
}

function unknownConfirmation(error) {
  return {
    status: 'unknown',
    effect_ref: null,
    predicate: 'portfolio-reconciliation-readback',
    evidence: { error: String(error?.message || error) },
  };
}

async function confirmationFacts(result, authority, input, intent) {
  if (result?.ok !== true) return unknownConfirmation(new Error(String(result?.error || 'portfolio readback failed')));
  const results = itemResults(result);
  const effect_ref = effectReference(authority, input, intent);
  if (results.length > 0 && results.every(value => value === 'would_reuse')) {
    return {
      status: 'confirmed',
      effect_ref,
      predicate: 'portfolio-reconciliation-projection-exact',
      evidence: result,
    };
  }
  if (results.length > 0 && results.every(value => value === 'would_ignore')) {
    return {
      status: 'absent',
      effect_ref: null,
      predicate: 'portfolio-reconciliation-no-effect-required',
      evidence: result,
    };
  }
  return {
    status: 'unknown',
    effect_ref: null,
    predicate: 'portfolio-reconciliation-readback',
    evidence: result,
  };
}

function replayResult(input, transaction) {
  return {
    ok: true,
    project: input.project,
    summary: null,
    items: [],
    idempotent_replay: true,
    execution_id: transaction.identity.execution_id,
    settlement_receipt: transaction.receipt,
  };
}

export function portfolioReconciliationFor(options = {}) {
  const executionTransactionStore = executionStoreFor(options);
  const authority = authorityFor(options);
  const readAuthority = options.readAuthority;
  if (typeof readAuthority !== 'function') {
    fail('EXECUTION_AUTHORITY_READER_REQUIRED', 'portfolio reconciliation requires an exact authority readback function');
  }
  const runId = String(options.run_id || options.runId || crypto.randomUUID()).trim();
  if (!runId) fail('EXECUTION_CONTEXT_INVALID', 'portfolio reconciliation run_id is required');

  async function reconcile(input) {
    const providerInput = providerInputFor(input);
    const intent = {
      project_ref: authority.project_ref,
      subject_key: authority.project_ref + ':portfolio:' + requiredText(input.project, 'project'),
      repository: authority.repository,
      authority_revision: authority.revision,
      authority_epoch: authority.epoch,
      graph_fingerprint: authority.graph_fingerprint,
      transition_fingerprint: authority.transition_fingerprint,
      observation: {
        project: input.project,
        repository: authority.repository,
        revision: authority.revision,
      },
      plan: { request: providerInput },
    };
    let invokedResult = null;
    const providerOptions = {
      ...options,
      receiptStore: null,
    };
    const transaction = await executePortfolioReconciliation(intent, {
      executionTransactionStore,
      executionContext() {
        return {
          run_id: runId,
          subject_kind: 'provider_operation',
          authority_epoch: authority.epoch,
          lease_ref: options.lease_ref,
          lease_epoch: options.lease_epoch,
          lease_expires_at: options.lease_expires_at || new Date(Date.now() + 60_000).toISOString(),
        };
      },
      providerFor() {
        return {
          async preflight() {
            const observed = await readAuthority({ authority, input });
            const observedRevision = typeof observed === 'string' ? observed : observed?.revision;
            return {
              provider: 'github',
              observed_revision: exactRevision(observedRevision, 'observed authority revision'),
              provider_identity: observed && typeof observed === 'object' ? observed : { revision: observedRevision },
            };
          },
          async invoke({ intent: providerIntent }) {
            invokedResult = await reconcilePortfolioWorkSurface(providerInput, providerOptions);
            return invocationFacts(invokedResult, authority, input, providerIntent);
          },
          async confirm({ intent: providerIntent }) {
            try {
              const readback = await reconcilePortfolioWorkSurface(providerInputFor(input, true), providerOptions);
              return confirmationFacts(readback, authority, input, providerIntent);
            } catch (error) {
              return unknownConfirmation(error);
            }
          },
        };
      },
    });
    if (transaction.receipt.disposition === 'completed') {
      if (invokedResult) {
        return {
          ...invokedResult,
          idempotent_replay: false,
          execution_id: transaction.identity.execution_id,
        };
      }
      return replayResult(input, transaction);
    }
    if (invokedResult) {
      return {
        ...invokedResult,
        execution_id: transaction.identity.execution_id,
        settlement_receipt: transaction.receipt,
      };
    }
    return {
      ok: false,
      error: 'EXECUTION_NOT_COMPLETED',
      message: 'portfolio reconciliation did not settle as completed',
      disposition: transaction.receipt.disposition,
      execution_id: transaction.identity.execution_id,
      may_have_mutated: transaction.receipt.disposition === 'escalated',
    };
  }

  return Object.freeze({ reconcile });
}

export async function reconcilePortfolioWorkSurfaceWithExecutionKernel(input, options = {}) {
  return portfolioReconciliationFor(options).reconcile(input);
}
