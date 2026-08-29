import { OPERATING_CONDITIONS, PRODUCTIVE_STAGES, WORK_REQUEUE_CLASSES, WORK_SETTLEMENT_DISPOSITIONS, } from './execution-lifecycle-contracts.js';
const responsibility = Object.freeze({
    type: 'object',
    required: ['applicable', 'satisfied'],
    properties: { applicable: { type: 'boolean' }, satisfied: { type: 'boolean' } },
    additionalProperties: false,
});
const lifecycleFacts = Object.freeze({
    type: ['object', 'null'],
    description: 'Lifecycle observations are valid only for completed settlement. Blocked and requeue settlements may omit lifecycle_facts or send null.',
    properties: {
        condition: { type: 'string', enum: [...OPERATING_CONDITIONS] },
        responsibilities: {
            type: 'object',
            properties: Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, responsibility])),
            additionalProperties: false,
        },
    },
    additionalProperties: false,
});
const nonNominalOperatingConditions = OPERATING_CONDITIONS.filter((condition) => condition !== 'NOMINAL');
export const WORK_SETTLE_INPUT_SCHEMA = Object.freeze({
    type: 'object',
    description: 'Settlement discovery contract. Request-local disposition rules are structurally encoded. Requirements that depend on persisted effective continuation are documented and remain fail-closed runtime checks.',
    required: ['lease_ref', 'disposition'],
    properties: {
        lease_ref: { type: 'string' },
        disposition: {
            type: 'string',
            enum: [...WORK_SETTLEMENT_DISPOSITIONS],
            description: 'Selects the settlement path and therefore which conditional fields are legal.',
        },
        evidence: { type: 'array', items: { type: 'object', required: ['kind', 'ref'], properties: { kind: { type: 'string' }, ref: { type: 'string' } }, additionalProperties: false } },
        reason: {
            type: ['string', 'null'],
            description: 'Required and non-empty for blocked settlement and wait_for_observable_change requeue.',
        },
        promotion_condition: {
            type: ['string', 'null'],
            description: 'Required and non-empty for blocked settlement.',
        },
        requeue_class: {
            type: ['string', 'null'],
            enum: [...WORK_REQUEUE_CLASSES, null],
            description: 'Allowed only for requeue. wait_for_observable_change requires a non-empty reason. stale_candidate requires an exact candidate in the effective continuation. resume_progress requires a durable checkpoint in the effective continuation. Effective continuation is resolved from submitted continuation plus persisted checkpoint/evidence, so those continuation requirements remain runtime-validated rather than caller-only schema requirements.',
        },
        operating_condition: {
            type: ['string', 'null'],
            enum: [...OPERATING_CONDITIONS, null],
            description: 'Defaults to HOLD for blocked settlement and NOMINAL otherwise. Blocked settlement must resolve off-nominal; completed and requeue settlement must resolve NOMINAL.',
        },
        continuation: {
            type: ['object', 'null'],
            description: 'Optional caller continuation. Runtime merges it with durable checkpoint/evidence before evaluating continuation-dependent requeue classes.',
        },
        lifecycle_facts: lifecycleFacts,
    },
    allOf: [
        {
            if: { properties: { disposition: { const: 'blocked' } }, required: ['disposition'] },
            then: {
                required: ['reason', 'promotion_condition'],
                properties: {
                    reason: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
                    promotion_condition: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
                    operating_condition: { enum: [...nonNominalOperatingConditions, null] },
                    requeue_class: { type: 'null' },
                    lifecycle_facts: { type: 'null' },
                },
            },
        },
        {
            if: { properties: { disposition: { const: 'completed' } }, required: ['disposition'] },
            then: {
                properties: {
                    operating_condition: { enum: ['NOMINAL', null] },
                    requeue_class: { type: 'null' },
                },
            },
        },
        {
            if: { properties: { disposition: { const: 'requeue' } }, required: ['disposition'] },
            then: {
                properties: {
                    operating_condition: { enum: ['NOMINAL', null] },
                    lifecycle_facts: { type: 'null' },
                },
            },
        },
        {
            if: {
                properties: {
                    disposition: { const: 'requeue' },
                    requeue_class: { const: 'wait_for_observable_change' },
                },
                required: ['disposition', 'requeue_class'],
            },
            then: {
                required: ['reason'],
                properties: {
                    reason: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
                },
            },
        },
    ],
    additionalProperties: false,
});
export const WORK_SETTLE_SEMANTIC_FIELDS = Object.freeze(Object.keys(WORK_SETTLE_INPUT_SCHEMA.properties));
export const WORK_SETTLE_REQUIRED_FIELDS = Object.freeze([...WORK_SETTLE_INPUT_SCHEMA.required]);
