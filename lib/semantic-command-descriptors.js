import { OPERATING_CONDITIONS, PRODUCTIVE_STAGES, WORK_REQUEUE_CLASSES, WORK_SETTLEMENT_DISPOSITIONS, } from './execution-lifecycle-contracts.js';
const responsibility = Object.freeze({
    type: 'object',
    required: ['applicable', 'satisfied'],
    properties: { applicable: { type: 'boolean' }, satisfied: { type: 'boolean' } },
    additionalProperties: false,
});
const lifecycleFacts = Object.freeze({
    type: ['object', 'null'],
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
const workSettleSchema = Object.freeze({
    type: 'object',
    required: ['lease_ref', 'disposition'],
    properties: {
        lease_ref: { type: 'string' },
        disposition: { type: 'string', enum: [...WORK_SETTLEMENT_DISPOSITIONS] },
        evidence: { type: 'array', items: { type: 'object', required: ['kind', 'ref'], properties: { kind: { type: 'string' }, ref: { type: 'string' } }, additionalProperties: false } },
        reason: { type: ['string', 'null'] },
        promotion_condition: { type: ['string', 'null'] },
        requeue_class: { type: ['string', 'null'], enum: [...WORK_REQUEUE_CLASSES, null] },
        operating_condition: { type: ['string', 'null'], enum: [...OPERATING_CONDITIONS, null] },
        continuation: { type: ['object', 'null'] },
        lifecycle_facts: lifecycleFacts,
    },
    additionalProperties: false,
});
const githubReleaseSchema = Object.freeze({
    type: 'object',
    required: ['repo', 'target_sha', 'tag_name', 'name', 'body', 'draft', 'prerelease', 'expected_state', 'idempotency_key', 'run_id'],
    additionalProperties: false,
    properties: {
        repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
        target_sha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
        tag_name: { type: 'string', minLength: 1, maxLength: 255 },
        name: { type: 'string', minLength: 1, maxLength: 256 },
        body: { type: 'string', maxLength: 125000 },
        draft: { type: 'boolean' },
        prerelease: { type: 'boolean' },
        expected_state: { type: 'object', required: ['tag', 'release'], additionalProperties: false, properties: { tag: { type: 'string', enum: ['absent', 'present_same_commit'] }, release: { type: 'string', enum: ['absent', 'present_matching'] } } },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
        run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
});
const orchestrationDiagnoseSchema = Object.freeze({
    type: 'object',
    required: ['run_id'],
    properties: {
        run_id: { type: 'string', minLength: 1, maxLength: 512 },
        work_ref: { type: 'string', minLength: 1, maxLength: 128 },
    },
    additionalProperties: false,
});
const projectDefineSchema = Object.freeze({
    type: 'object',
    required: ['project_ref', 'expected_revision', 'definition'],
    properties: {
        project_ref: { type: 'string', pattern: '^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
        expected_revision: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
        definition: { type: 'object' },
    },
    additionalProperties: false,
});
const projectAmendSchema = Object.freeze({
    type: 'object',
    required: ['project_ref', 'expected_revision', 'amendment'],
    properties: {
        project_ref: { type: 'string', pattern: '^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
        expected_revision: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
        amendment: { type: 'object' },
    },
    additionalProperties: false,
});
function descriptor(command, mcpName, description, inputSchema, exposure = Object.freeze({ worker: true, mcp: true })) {
    return Object.freeze({
        command,
        mcp_name: mcpName,
        description,
        input_schema: inputSchema,
        semantic_fields: Object.freeze(Object.keys(inputSchema.properties)),
        required_fields: Object.freeze([...(inputSchema.required || [])]),
        exposure,
    });
}
const DESCRIPTORS = Object.freeze({
    'github.release.create': descriptor('github.release.create', 'github_release_create', 'Create an immutable lightweight Git tag at an exact observed Git commit and a GitHub Release for that tag. Fail closed on expected-state drift or conflicting existing state. Exact replay converges through durable idempotency evidence; no tag retargeting, release editing, deletion, asset upload, note generation, or commit inference is performed. This MCP tool exposes conceptual github.release.create using the underscore-safe transport name.', githubReleaseSchema),
    'orchestration.diagnose': descriptor('orchestration.diagnose', 'orchestration.diagnose', 'Read current durable orchestration state and return the typed failure class, exact deterministic recovery operation, and escalation boundary. This is state inspection and recovery classification only; it does not plan or select work.', orchestrationDiagnoseSchema),
    'work.settle': descriptor('work.settle', 'work.settle', 'Truthfully consume one valid work lease as completed, requeue, or blocked. Supply the non-secret lease_ref plus settlement semantics; lease capability lookup, run correlation, and deterministic retry identity are derived internally.', workSettleSchema),
});
const PROJECT_AUTHORING_DESCRIPTORS = Object.freeze({
    'project.define': descriptor('project.define', 'project.define', 'Define canonical repository-owned project graph facts at an exact observed Git revision. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.', projectDefineSchema, Object.freeze({ worker: false, mcp: false })),
    'project.amend': descriptor('project.amend', 'project.amend', 'Amend canonical repository-owned project graph facts at an exact observed Git revision using semantic transition intent. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.', projectAmendSchema, Object.freeze({ worker: false, mcp: false })),
});
const ALL_DESCRIPTORS = Object.freeze({ ...DESCRIPTORS, ...PROJECT_AUTHORING_DESCRIPTORS });
export const MIGRATED_SEMANTIC_COMMANDS = Object.freeze(Object.keys(DESCRIPTORS));
export function semanticCommandDescriptor(command) {
    if (!Object.prototype.hasOwnProperty.call(ALL_DESCRIPTORS, command)) {
        throw new Error(`Semantic command descriptor is not migrated: ${command}`);
    }
    return ALL_DESCRIPTORS[command];
}
