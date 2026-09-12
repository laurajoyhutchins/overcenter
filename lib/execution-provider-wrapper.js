import { canonicalJson, sha256Text } from './canonical-json.js';
import { executeExecutionTransaction } from './execution-transaction-runtime.js';
function required(value, field) {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!result) {
        throw Object.assign(new Error(field + ' is required'), {
            code: 'EXECUTION_WRAPPER_INVALID',
            field,
        });
    }
    return result;
}
export function executionAuthority(input) {
    return Object.freeze({
        project_ref: required(input.project_ref, 'project_ref'),
        repository: required(input.repository, 'repository'),
        revision: required(input.authority_revision, 'authority_revision'),
        epoch: Number.isSafeInteger(input.authority_epoch) && input.authority_epoch >= 0
            ? input.authority_epoch
            : (() => { throw Object.assign(new Error('authority_epoch is invalid'), { code: 'EXECUTION_WRAPPER_INVALID' }); })(),
        graph_fingerprint: required(input.graph_fingerprint, 'graph_fingerprint'),
        transition_fingerprint: required(input.transition_fingerprint, 'transition_fingerprint'),
    });
}
export async function executeBoundProviderEffect(input) {
    const operationKind = required(input.operation_kind, 'operation_kind');
    const subjectKey = required(input.request.subject_key, 'subject_key');
    const projectRef = required(input.request.project_ref, 'project_ref');
    if (input.authority.project_ref !== projectRef) {
        throw Object.assign(new Error('authority project_ref does not match request'), {
            code: 'EXECUTION_AUTHORITY_MISMATCH',
        });
    }
    if (!input.ports?.executionTransactionStore
        || typeof input.ports.executionContext !== 'function'
        || typeof input.ports.providerFor !== 'function') {
        throw Object.assign(new Error('execution wrapper ports are incomplete'), {
            code: 'EXECUTION_WRAPPER_UNAVAILABLE',
        });
    }
    const idempotencyKey = await sha256Text(canonicalJson({
        schema: 'execution-operation-intent-v1',
        operation_kind: operationKind,
        request: input.request,
    }));
    const intent = {
        project_ref: projectRef,
        subject_key: subjectKey,
        authority: input.authority,
        operation: {
            kind: operationKind,
            idempotency_scope: required(input.idempotency_scope, 'idempotency_scope'),
            idempotency_key: idempotencyKey,
            payload: input.payload,
        },
    };
    const context = input.ports.executionContext(input.request);
    const subjectKind = input.subject_kind || 'provider_operation';
    if (!['provider_operation', 'project_transition', 'legacy_work'].includes(subjectKind)
        || context.subject_kind !== subjectKind) {
        throw Object.assign(new Error('execution subject kind does not match the provider effect binding'), {
            code: 'EXECUTION_SUBJECT_KIND_MISMATCH',
        });
    }
    return executeExecutionTransaction({
        intent,
        context,
        provider: input.ports.providerFor(input.request, input.authority),
        store: input.ports.executionTransactionStore,
    });
}
