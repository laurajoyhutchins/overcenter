import { canonicalJson, sha256Text } from './canonical-json.js';
import { executeDeterministicWorkSettlement } from './deterministic-work-settlement-execution.js';
import {
  createDeterministicWorkSettlementService,
  createPostgresDeterministicWorkSettlementDependencies,
  deterministicWorkPredicates,
  evaluateDeterministicWorkPredicate,
} from './deterministic-work-settlement.js';

const SHA40 = /^[0-9a-f]{40}$/i;
const TERMINAL_TYPES = new Set(['completed', 'canceled', 'duplicate']);

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details, may_have_mutated: false });
}

function text(value, field) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) fail('DETERMINISTIC_SETTLEMENT_INVALID', field + ' is required', { field });
  return result;
}

function revision(value, field) {
  const result = text(value, field).toLowerCase();
  if (!SHA40.test(result)) fail('DETERMINISTIC_SETTLEMENT_INVALID', field + ' must be an exact Git revision', { field });
  return result;
}

function authorityFor(options = {}) {
  const authority = options.authority;
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    fail('EXECUTION_AUTHORITY_REQUIRED', 'deterministic work settlement requires an authoritative project graph coordinate');
  }
  const epoch = Number(authority.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail('EXECUTION_AUTHORITY_INVALID', 'authority.epoch is invalid');
  return Object.freeze({
    project_ref:text(authority.project_ref, 'authority.project_ref'),
    repository:text(authority.repository, 'authority.repository'),
    revision:revision(authority.revision, 'authority.revision'),
    epoch,
    graph_fingerprint:text(authority.graph_fingerprint, 'authority.graph_fingerprint'),
    transition_fingerprint:text(authority.transition_fingerprint, 'authority.transition_fingerprint'),
  });
}

function dependenciesFor(options) {
  if (options.cycleStore && options.cycleService && options.linear) {
    return {
      cycleStore:options.cycleStore,
      cycleService:options.cycleService,
      linear:options.linear,
    };
  }
  return createPostgresDeterministicWorkSettlementDependencies(options);
}


function selectedPredicates(input = {}, options = {}) {
  const requested = input.predicate_key || options.predicate_key;
  const predicates = options.predicates || deterministicWorkPredicates;
  if (!requested) return [...predicates];
  const predicate = predicates.find(candidate => candidate.predicate_key === requested);
  if (!predicate) fail('DETERMINISTIC_SETTLEMENT_PREDICATE_UNKNOWN', 'deterministic settlement predicate is not registered', { predicate_key:requested });
  return [predicate];
}

function effectRef(authority, predicate) {
  return `linear-deterministic-settlement:${predicate.work_ref}:${predicate.predicate_key}@${authority.revision}`;
}

function terminal(issue) {
  return Boolean(issue?.archivedAt) || TERMINAL_TYPES.has(String(issue?.state?.type || '').toLowerCase());
}

async function invokeFacts(result, authority, predicate) {
  const evidence = result && typeof result === 'object' ? result : { result:String(result ?? '') };
  const response_sha256 = await sha256Text(canonicalJson(evidence));
  const row = result?.results?.[0];
  if (row?.status === 'settled' || row?.status === 'receipt_recorded' || row?.status === 'already_settled') {
    return {
      transport:'accepted',
      committed:true,
      effect_ref:effectRef(authority, predicate),
      response_sha256,
      evidence,
    };
  }
  if (result?.ok === true && row?.status === 'pending') {
    return {
      transport:'rejected',
      committed:false,
      effect_ref:null,
      response_sha256,
      evidence,
    };
  }
  return {
    transport:'rejected',
    committed:false,
    effect_ref:null,
    response_sha256,
    evidence,
  };
}

async function confirmFacts(dependencies, authority, predicate) {
  const evaluation = await evaluateDeterministicWorkPredicate({ predicate, ...dependencies });
  const issue = await dependencies.linear.getIssue(predicate.work_ref);
  if (evaluation?.satisfied === true && terminal(issue)) {
    return {
      status:'confirmed',
      effect_ref:effectRef(authority, predicate),
      predicate:'deterministic-work-settlement-terminal-state',
      evidence:{ predicate, evaluation, issue },
    };
  }
  if (!evaluation?.satisfied && issue && !terminal(issue)) {
    return {
      status:'absent',
      effect_ref:null,
      predicate:'deterministic-work-settlement-absent',
      evidence:{ predicate, evaluation, issue },
    };
  }
  return {
    status:'unknown',
    effect_ref:null,
    predicate:'deterministic-work-settlement-readback',
    evidence:{ predicate, evaluation, issue },
  };
}

export function deterministicWorkSettlementFor(options = {}) {
  const executionTransactionStore = options.executionTransactionStore;
  if (!executionTransactionStore || typeof executionTransactionStore.prepareExecution !== 'function') {
    fail('EXECUTION_TRANSACTION_STORE_REQUIRED', 'deterministic work settlement requires the authoritative execution transaction store');
  }
  const readAuthority = options.readAuthority;
  if (typeof readAuthority !== 'function') {
    fail('EXECUTION_AUTHORITY_READER_REQUIRED', 'deterministic work settlement requires an exact authority readback function');
  }
  const authority = authorityFor(options);
  const dependencies = dependenciesFor(options);
  const predicates = selectedPredicates({}, options);
  const runId = String(options.run_id || options.runId || crypto.randomUUID()).trim();
  const providerOptions = { ...options, ...dependencies };

  async function reconcile(input = {}) {
    const chosen = selectedPredicates(input, options);
    const results = [];
    for (const predicate of chosen) {
      const request = {
        project_ref:authority.project_ref,
        subject_key:authority.project_ref + ':deterministic-work:' + predicate.predicate_key,
        repository:authority.repository,
        authority_revision:authority.revision,
        authority_epoch:authority.epoch,
        graph_fingerprint:authority.graph_fingerprint,
        transition_fingerprint:authority.transition_fingerprint,
        work_ref:predicate.work_ref,
        predicate_key:predicate.predicate_key,
        target_state:predicate.target_state || 'Done',
        evaluation:await evaluateDeterministicWorkPredicate({ predicate, ...dependencies }),
      };
      let invokedResult = null;
      const transaction = await executeDeterministicWorkSettlement(request, {
        executionTransactionStore,
        executionContext() {
          return {
            run_id:runId + ':' + predicate.predicate_key,
            subject_kind:'provider_operation',
            authority_epoch:authority.epoch,
            lease_expires_at:options.lease_expires_at || new Date(Date.now() + 60_000).toISOString(),
          };
        },
        providerFor() {
          return {
            async preflight() {
              const observed = await readAuthority({ authority, predicate });
              const observedRevision = typeof observed === 'string' ? observed : observed?.revision;
              return {
                provider:'github',
                observed_revision:revision(observedRevision, 'observed authority revision'),
                provider_identity:observed && typeof observed === 'object' ? observed : { revision:observedRevision },
              };
            },
            async invoke() {
              const service = createDeterministicWorkSettlementService({
                ...providerOptions,
                predicates:[predicate],
              });
              invokedResult = await service.reconcile();
              return invokeFacts(invokedResult, authority, predicate);
            },
            async confirm() {
              try {
                return await confirmFacts(dependencies, authority, predicate);
              } catch (error) {
                return {
                  status:'unknown',
                  effect_ref:null,
                  predicate:'deterministic-work-settlement-readback',
                  evidence:{ error:String(error?.message || error) },
                };
              }
            },
          };
        },
      });
      results.push(invokedResult
        ? { ...invokedResult.results?.[0], execution_id:transaction.identity.execution_id, settlement_receipt:transaction.receipt }
        : {
          predicate_key:predicate.predicate_key,
          work_ref:predicate.work_ref,
          status:transaction.receipt.disposition === 'completed' ? 'recovered' : 'unsettled',
          execution_id:transaction.identity.execution_id,
          settlement_receipt:transaction.receipt,
        });
    }
    return {
      ok:results.every(result => result.status !== 'unsettled'),
      settled_count:results.filter(result => result.status === 'settled').length,
      receipt_count:results.filter(result => ['settled','recovered'].includes(result.status)).length,
      results,
    };
  }

  return Object.freeze({ reconcile });
}

export async function reconcileDeterministicWorkSettlement(input = {}, options = {}) {
  return deterministicWorkSettlementFor(options).reconcile(input);
}
