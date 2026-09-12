import { canonicalJson, sha256Text } from './canonical-json.js';
import { executeProjectAuthoring as defaultExecuteProjectAuthoring } from './project-authoring-execution.js';

const SHA40 = /^[0-9a-f]{40}$/i;

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details, may_have_mutated: false });
}

function text(value, field) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) fail('PROJECT_AUTHORING_EXECUTION_INVALID', field + ' is required', { field });
  return result;
}

function exactRevision(value, field) {
  const result = text(value, field).toLowerCase();
  if (!SHA40.test(result)) fail('PROJECT_AUTHORING_EXECUTION_INVALID', field + ' must be an exact Git revision', { field });
  return result;
}

function operationFor(input) {
  if (input?.definition && !input?.amendment) return 'define';
  if (input?.amendment && !input?.definition) return 'amend';
  fail('PROJECT_AUTHORING_EXECUTION_INVALID', 'exactly one project authoring operation is required');
}

function authorityFor(input, resolved, epoch) {
  const project_ref = text(input.project_ref, 'project_ref');
  const repository = text(resolved?.repository, 'authority.repository');
  const revision = exactRevision(input.expected_revision, 'expected_revision');
  const observed = exactRevision(resolved?.revision, 'authority.revision');
  if (resolved?.project_ref !== project_ref || observed !== revision) {
    fail('PROJECT_AUTHORING_AUTHORITY_STALE', 'project authoring authority changed before the transaction began', {
      project_ref,
      expected_revision:revision,
      observed_revision:observed,
    });
  }
  return {
    project_ref,
    repository,
    revision,
    epoch,
    graph_fingerprint:'project-graph:' + text(resolved?.derivation, 'authority.derivation'),
    transition_fingerprint:'project-authoring:' + operationFor(input) + ':' + project_ref,
  };
}

function evidenceFor(result) {
  return result && typeof result === 'object' && !Array.isArray(result) ? result : { result:String(result ?? '') };
}

async function invocationFacts(result, authority, input) {
  const evidence = evidenceFor(result);
  const response_sha256 = await sha256Text(canonicalJson(evidence));
  const stagedRevision = String(result?.revision || result?.new_head || result?.commit_sha || '').trim().toLowerCase();
  if (result?.may_have_mutated === true || result?.error === 'PROJECT_AUTHORING_MUTATION_UNCONFIRMED') {
    return { transport:'unknown', committed:null, effect_ref:null, response_sha256:null, evidence };
  }
  if (!stagedRevision || !SHA40.test(stagedRevision)) {
    return { transport:'rejected', committed:false, effect_ref:null, response_sha256, evidence };
  }
  return {
    transport:'accepted',
    committed:true,
    effect_ref:'github-project-authoring:' + authority.repository + '@' + stagedRevision + ':' + operationFor(input),
    response_sha256,
    evidence,
  };
}

function unknownConfirmation(error = null) {
  return {
    status:'unknown',
    effect_ref:null,
    predicate:'project-authoring-readback',
    evidence:{ error:String(error?.message || error || 'authoritative project authoring readback is unavailable') },
  };
}

export function createProjectAuthoringExecutionRuntime(options = {}) {
  const store = options.executionTransactionStore;
  if (!store || typeof store.prepareExecution !== 'function') {
    fail('EXECUTION_TRANSACTION_STORE_REQUIRED', 'project authoring requires the authoritative execution transaction store');
  }
  const primitive = options.primitive;
  if (!primitive || typeof primitive.define !== 'function' || typeof primitive.amend !== 'function') {
    fail('PROJECT_AUTHORING_RUNTIME_UNAVAILABLE', 'project authoring provider mechanics are unavailable');
  }
  const graphRuntime = options.graphRuntime;
  if (!graphRuntime || typeof graphRuntime.resolveProjectAuthority !== 'function') {
    fail('PROJECT_GRAPH_GITHUB_READER_UNAVAILABLE', 'project authoring requires the GitHub project graph authority reader');
  }
  const execute = options.executeProjectAuthoring || defaultExecuteProjectAuthoring;
  const epoch = Number(options.authority_epoch ?? options.authorityEpoch ?? options.invocationContext?.authority_epoch ?? 0);
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail('PROJECT_AUTHORING_AUTHORITY_INVALID', 'authority epoch is invalid');
  const runId = String(options.run_id || options.runId || options.invocationContext?.run_id || crypto.randomUUID()).trim();
  const confirm = options.confirmProjectAuthoring;

  async function author(input = {}) {
    const operation = operationFor(input);
    const resolved = await graphRuntime.resolveProjectAuthority({ project_ref:input.project_ref });
    const authority = authorityFor(input, resolved, epoch);
    const request = {
      ...authority,
      subject_key:authority.project_ref + ':authoring:' + operation + ':' + authority.revision,
      expected_revision:authority.revision,
      definition:input.definition || {},
      amendment:input.amendment || {},
    };
    let invokedResult = null;
    const transaction = await execute(request, {
      executionTransactionStore:store,
      executionContext() {
        return {
          run_id:runId,
          subject_kind:'provider_operation',
          authority_epoch:authority.epoch,
          lease_expires_at:options.lease_expires_at || new Date(Date.now() + 60_000).toISOString(),
        };
      },
      providerFor() {
        return {
          async preflight() {
            const fresh = await graphRuntime.resolveProjectAuthority({ project_ref:authority.project_ref });
            const observed = exactRevision(fresh?.revision, 'authority.revision');
            return {
              provider:'github',
              observed_revision:observed,
              provider_identity:fresh && typeof fresh === 'object' ? fresh : { revision:observed },
            };
          },
          async invoke() {
            invokedResult = await primitive[operation](input);
            return invocationFacts(invokedResult, authority, input);
          },
          async confirm({ identity }) {
            if (typeof confirm !== 'function') return unknownConfirmation();
            try {
              return await confirm({ input, operation, authority, identity });
            } catch (error) {
              return unknownConfirmation(error);
            }
          },
        };
      },
    });
    if (transaction.receipt.disposition === 'completed') {
      if (invokedResult) return { ...invokedResult, execution_id:transaction.identity.execution_id, idempotent_replay:false };
      return {
        ok:true,
        project_ref:authority.project_ref,
        operation,
        execution_id:transaction.identity.execution_id,
        idempotent_replay:true,
        settlement_receipt:transaction.receipt,
      };
    }
    return {
      ...(invokedResult || { ok:false }),
      execution_id:transaction.identity.execution_id,
      settlement_receipt:transaction.receipt,
      ...(invokedResult ? {} : { error:'PROJECT_AUTHORING_EXECUTION_NOT_COMPLETED' }),
    };
  }

  return Object.freeze({
    define:author,
    amend:author,
  });
}
