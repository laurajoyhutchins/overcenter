import { OPERATING_CONDITIONS, PRODUCTIVE_STAGES, WORK_REQUEUE_CLASSES, WORK_SETTLEMENT_DISPOSITIONS, } from './execution-lifecycle-contracts.js';
export const SEMANTIC_COMMAND_SURFACES = Object.freeze(['primary', 'advanced', 'operator', 'compatibility']);
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
        operating_condition: { type: ['string', 'null'], enum: [...OPERATING_CONDITIONS, null], description: 'Omitted or null defaults to HOLD for blocked settlements and NOMINAL otherwise.' },
        continuation: { type: ['object', 'null'], description: 'The effective continuation merges caller-provided continuation with persisted state. resume_progress requires a durable checkpoint there; stale_candidate requires an exact candidate there.' },
        lifecycle_facts: lifecycleFacts,
    },
    allOf: [
        { if: { properties: { disposition: { const: 'blocked' } }, required: ['disposition'] }, then: { required: ['reason', 'promotion_condition'], properties: { reason: { type: 'string', minLength: 1 }, promotion_condition: { type: 'string', minLength: 1 } } } },
        { if: { properties: { disposition: { const: 'blocked' } }, required: ['disposition'] }, then: { properties: { operating_condition: { type: ['string', 'null'], enum: [...OPERATING_CONDITIONS.filter((condition) => condition !== 'NOMINAL'), null] } } } },
        { if: { properties: { disposition: { enum: ['completed', 'requeue'] } }, required: ['disposition'] }, then: { properties: { operating_condition: { type: ['string', 'null'], enum: ['NOMINAL', null] } } } },
        { if: { properties: { requeue_class: { not: { type: 'null' } } }, required: ['requeue_class'] }, then: { properties: { disposition: { const: 'requeue' } } } },
        { if: { properties: { lifecycle_facts: { not: { type: 'null' } } }, required: ['lifecycle_facts'] }, then: { properties: { disposition: { const: 'completed' } } } },
        { if: { properties: { disposition: { const: 'requeue' }, requeue_class: { const: 'wait_for_observable_change' } }, required: ['disposition', 'requeue_class'] }, then: { required: ['reason'], properties: { reason: { type: 'string', minLength: 1 } } } },
    ],
    additionalProperties: false,
});
const githubPullRequestMarkReadySchema = Object.freeze({
    type: 'object',
    required: ['repo', 'pull_request', 'expected_head'],
    additionalProperties: false,
    properties: {
        repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', description: 'Repository in owner/repo form.' },
        pull_request: { type: 'integer', minimum: 1, description: 'Open pull request number.' },
        expected_head: { type: 'string', pattern: '^[0-9a-fA-F]{40}$', description: 'Exact current pull request head SHA. Any movement invalidates the request.' },
        run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run id used only for correlation.' },
    },
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
const productionPromoteSchema = Object.freeze({
    type: 'object',
    required: ['repo'],
    properties: {
        repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
    },
    additionalProperties: false,
});
const releasePublishSchema = Object.freeze({
    type: 'object',
    required: ['plan', 'body'],
    properties: {
        plan: { type: 'object' },
        body: { type: 'string', maxLength: 125000 },
    },
    additionalProperties: false,
});
const projectAdvanceSchema = Object.freeze({
    type: 'object',
    required: ['project_ref'],
    properties: {
        project_ref: { type: 'string', pattern: '^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
        transition_id: { type: 'string', minLength: 1, maxLength: 256, pattern: '^\\S+$' },
        resume_ref: { type: 'string', minLength: 1, maxLength: 512, pattern: '^\\S+$' },
        execution_result: {
            type: 'object',
            required: ['disposition'],
            properties: {
                disposition: { type: 'string', enum: [...WORK_SETTLEMENT_DISPOSITIONS] },
                evidence: { type: 'array', items: { type: 'object', required: ['kind', 'ref'], properties: { kind: { type: 'string' }, ref: { type: 'string' } }, additionalProperties: false } },
                reason: { type: ['string', 'null'] },
            },
            additionalProperties: false,
        },
    },
    additionalProperties: false,
});
const projectInspectSchema = Object.freeze({
    type: 'object',
    required: ['project_ref'],
    properties: {
        project_ref: { type: 'string', pattern: '^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
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
function descriptor(command, mcpName, description, inputSchema, surface, exposure = Object.freeze({ worker: true, mcp: true })) {
    return Object.freeze({
        command,
        mcp_name: mcpName,
        description,
        input_schema: inputSchema,
        semantic_fields: Object.freeze(Object.keys(inputSchema.properties)),
        required_fields: Object.freeze([...(inputSchema.required || [])]),
        exposure,
        surface,
    });
}
const INTERNAL_EXPOSURE = Object.freeze({ worker: true, mcp: false });
const DESCRIPTORS = Object.freeze({
    'github.pull_request.mark_ready': descriptor('github.pull_request.mark_ready', 'github_pull_request_mark_ready', 'Mark an exact-head draft pull request ready for review through the Overcenter GitHub App. The command fails closed if GitHub does not authorize the installation actor for this PR, never retries a mutation blindly, and authoritatively rereads state after uncertain mutation transport.', githubPullRequestMarkReadySchema, 'advanced', INTERNAL_EXPOSURE),
    'github.release.create': descriptor('github.release.create', 'github_release_create', 'Create an immutable lightweight Git tag at an exact observed Git commit and a GitHub Release for that tag. Fail closed on expected-state drift or conflicting existing state. Exact replay converges through durable idempotency evidence; no tag retargeting, release editing, deletion, asset upload, note generation, or commit inference is performed.', githubReleaseSchema, 'advanced', INTERNAL_EXPOSURE),
    'orchestration.diagnose': descriptor('orchestration.diagnose', 'orchestration.diagnose', 'Read current durable orchestration state and return the typed failure class, exact deterministic recovery operation, and escalation boundary. This is state inspection and recovery classification only; it does not plan or select work.', orchestrationDiagnoseSchema, 'operator', INTERNAL_EXPOSURE),
    'production.promote': descriptor('production.promote', 'production.promote', 'Promote the current verified development revision by repository identity only. The runtime host derives provider-specific branch heads, exact-revision evidence, retry identity, and production readback behind this primary semantic boundary.', productionPromoteSchema, 'primary', Object.freeze({ worker: true, mcp: true })),
    'project.advance': descriptor('project.advance', 'project.advance', 'Advance authoritative repository-owned project work in an independent agent session. Omit transition_id for deterministic best-available selection, or nominate one exact transition without fallback. Resume by passing the durable resume_ref returned by a prior call; when agent execution is complete, return its bounded execution_result through this same command. Overcenter owns run identity, lease acquisition, settlement, exact authority, recovery, and continuation.', projectAdvanceSchema, 'primary', Object.freeze({ worker: true, mcp: true })),
    'project.inspect': descriptor('project.inspect', 'project.inspect', 'Inspect authoritative repository-owned project state by project identity only. The runtime adapter derives the exact GitHub authority revision and graph frontier while keeping repository layout and host-specific runtime coordinates outside the primary semantic intent.', projectInspectSchema, 'primary', Object.freeze({ worker: true, mcp: true })),
    'release.publish': descriptor('release.publish', 'release.publish', 'Publish one exact verified semantic release plan. The caller supplies only the plan and release notes; Overcenter revalidates current Git authority and repository-owned transition impacts, derives provider release bookkeeping, invokes the immutable release primitive, and returns verified publication evidence.', releasePublishSchema, 'primary', Object.freeze({ worker: true, mcp: true })),
    'work.settle': descriptor('work.settle', 'work.settle', 'Truthfully consume one valid work lease as completed, requeue, or blocked. Supply the non-secret lease_ref plus settlement semantics; lease capability lookup, run correlation, and deterministic retry identity are derived internally.', workSettleSchema, 'compatibility', INTERNAL_EXPOSURE),
});
const PROJECT_AUTHORING_DESCRIPTORS = Object.freeze({
    'project.define': descriptor('project.define', 'project.define', 'Define canonical repository-owned project graph facts at an exact observed Git revision. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.', projectDefineSchema, 'primary', Object.freeze({ worker: true, mcp: true })),
    'project.amend': descriptor('project.amend', 'project.amend', 'Amend canonical repository-owned project graph facts at an exact observed Git revision using semantic transition intent. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.', projectAmendSchema, 'primary', Object.freeze({ worker: true, mcp: true })),
});
const ALL_DESCRIPTORS = Object.freeze({ ...DESCRIPTORS, ...PROJECT_AUTHORING_DESCRIPTORS });
export const MIGRATED_SEMANTIC_COMMANDS = Object.freeze(Object.keys(ALL_DESCRIPTORS));
export function semanticCommandDescriptor(command) {
    if (!Object.prototype.hasOwnProperty.call(ALL_DESCRIPTORS, command)) {
        throw new Error(`Semantic command descriptor is not migrated: ${command}`);
    }
    return ALL_DESCRIPTORS[command];
}
export function semanticCommandDescriptorsForSurface(surface) {
    return Object.freeze(MIGRATED_SEMANTIC_COMMANDS
        .map((command) => semanticCommandDescriptor(command))
        .filter((descriptor) => descriptor.surface === surface && descriptor.exposure.mcp));
}
export function semanticMcpDiscoveryForSurface(surface) {
    return Object.freeze(semanticCommandDescriptorsForSurface(surface).map((descriptor) => Object.freeze({
        command: descriptor.command,
        name: descriptor.mcp_name,
        description: descriptor.description,
        input_schema: descriptor.input_schema,
    })));
}
