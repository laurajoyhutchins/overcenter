import {
  OPERATING_CONDITIONS,
  PRODUCTIVE_STAGES,
  WORK_REQUEUE_CLASSES,
  WORK_SETTLEMENT_DISPOSITIONS,
} from './execution-lifecycle-contracts.js';

export const SEMANTIC_COMMAND_SURFACES = Object.freeze(['primary', 'advanced', 'operator', 'compatibility'] as const);
export type SemanticCommandSurface = (typeof SEMANTIC_COMMAND_SURFACES)[number];

export type SemanticCommandExposure = Readonly<{
  worker: boolean;
  mcp: boolean;
}>;

export type SemanticCommandDescriptor = Readonly<{
  command: string;
  mcp_name: string;
  description: string;
  input_schema: Readonly<Record<string, unknown>>;
  semantic_fields: readonly string[];
  required_fields: readonly string[];
  exposure: SemanticCommandExposure;
  surface: SemanticCommandSurface;
}>;

export type SemanticMcpDiscoveryEntry = Readonly<{
  command: string;
  name: string;
  description: string;
  input_schema: Readonly<Record<string, unknown>>;
}>;

const responsibility = Object.freeze({
  type:'object',
  required:['applicable','satisfied'],
  properties:{applicable:{type:'boolean'},satisfied:{type:'boolean'}},
  additionalProperties:false,
});

const lifecycleFacts = Object.freeze({
  type:['object','null'],
  properties:{
    condition:{type:'string',enum:[...OPERATING_CONDITIONS]},
    responsibilities:{
      type:'object',
      properties:Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, responsibility])),
      additionalProperties:false,
    },
  },
  additionalProperties:false,
});

const workSettleSchema = Object.freeze({
  type:'object',
  required:['lease_ref','disposition'],
  properties:{
    lease_ref:{type:'string'},
    disposition:{type:'string',enum:[...WORK_SETTLEMENT_DISPOSITIONS]},
    evidence:{type:'array',items:{type:'object',required:['kind','ref'],properties:{kind:{type:'string'},ref:{type:'string'}},additionalProperties:false}},
    reason:{type:['string','null']},
    promotion_condition:{type:['string','null']},
    requeue_class:{type:['string','null'],enum:[...WORK_REQUEUE_CLASSES,null]},
    operating_condition:{type:['string','null'],enum:[...OPERATING_CONDITIONS,null]},
    continuation:{type:['object','null']},
    lifecycle_facts:lifecycleFacts,
  },
  additionalProperties:false,
});

const githubChangesetChangeSchema = Object.freeze({
  type:'object',
  required:['path','operation'],
  properties:{
    path:{type:'string',minLength:1,maxLength:4096,description:'Repository-relative path.'},
    operation:{type:'string',enum:['create','update','delete']},
    content:{type:'string',description:'Complete UTF-8 content for create/update.'},
    ensure_final_newline:{type:'boolean'},
  },
  additionalProperties:false,
});

const githubApplyChangesetSchema = Object.freeze({
  type:'object',
  required:['lease_ref','changes','commit_message'],
  properties:{
    lease_ref:{type:'string',minLength:1,maxLength:128,description:'Project-transition lease reference from AGENT_EXECUTION_REQUIRED.'},
    changes:{type:'array',minItems:1,items:githubChangesetChangeSchema,description:'Complete repository changes. Repository, branch, base, expected head, retry identity, and credential authority are derived from the lease.'},
    commit_message:{type:'string',minLength:1,maxLength:10000},
  },
  additionalProperties:false,
});

const githubApplyTextReplacementsSchema = Object.freeze({
  type:'object',
  required:['lease_ref','replacements','commit_message'],
  properties:{
    lease_ref:{type:'string',minLength:1,maxLength:128,description:'Project-transition lease reference from AGENT_EXECUTION_REQUIRED.'},
    replacements:{
      type:'array',minItems:1,maxItems:32,
      items:{
        type:'object',required:['path','old','new_text'],additionalProperties:false,
        properties:{
          path:{type:'string',minLength:1,maxLength:4096},
          old:{type:'string',minLength:1},
          new_text:{type:'string'},
          expected_count:{type:'integer',minimum:1,default:1},
        },
      },
      description:'Exact text replacements read from the same immutable workspace observation that the later mutation is fenced against.',
    },
    commit_message:{type:'string',minLength:1,maxLength:10000},
  },
  additionalProperties:false,
});

const githubPullRequestMarkReadySchema = Object.freeze({
  type:'object',
  required:['repo','pull_request','expected_head'],
  additionalProperties:false,
  properties:{
    repo:{type:'string',minLength:3,maxLength:256,pattern:'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',description:'Repository in owner/repo form.'},
    pull_request:{type:'integer',minimum:1,description:'Open pull request number.'},
    expected_head:{type:'string',pattern:'^[0-9a-fA-F]{40}$',description:'Exact current pull request head SHA. Any movement invalidates the request.'},
    run_id:{type:'string',minLength:1,maxLength:512,description:'Optional orchestration run id used only for correlation.'},
  },
});

const githubReleaseSchema = Object.freeze({
  type:'object',
  required:['repo','target_sha','tag_name','name','body','draft','prerelease','expected_state','idempotency_key','run_id'],
  additionalProperties:false,
  properties:{
    repo:{type:'string',minLength:3,maxLength:256,pattern:'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'},
    target_sha:{type:'string',pattern:'^[0-9a-fA-F]{40}$'},
    tag_name:{type:'string',minLength:1,maxLength:255},
    name:{type:'string',minLength:1,maxLength:256},
    body:{type:'string',maxLength:125000},
    draft:{type:'boolean'},
    prerelease:{type:'boolean'},
    expected_state:{type:'object',required:['tag','release'],additionalProperties:false,properties:{tag:{type:'string',enum:['absent','present_same_commit']},release:{type:'string',enum:['absent','present_matching']}}},
    idempotency_key:{type:'string',minLength:1,maxLength:200},
    run_id:{type:'string',minLength:1,maxLength:512},
  },
});

const orchestrationDiagnoseSchema = Object.freeze({
  type:'object',
  required:['run_id'],
  properties:{
    run_id:{type:'string',minLength:1,maxLength:512},
    work_ref:{type:'string',minLength:1,maxLength:128},
  },
  additionalProperties:false,
});

const productionPromoteSchema = Object.freeze({
  type:'object',
  required:['repo'],
  properties:{
    repo:{type:'string',minLength:3,maxLength:256,pattern:'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'},
  },
  additionalProperties:false,
});

const productionReconcileSchema = productionPromoteSchema;

const releasePublishSchema = Object.freeze({
  type:'object',
  required:['plan','body'],
  properties:{
    plan:{type:'object'},
    body:{type:'string',maxLength:125000},
  },
  additionalProperties:false,
});

const projectAdvanceSchema = Object.freeze({
  type:'object',
  required:['project_ref'],
  properties:{
    project_ref:{type:'string',pattern:'^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'},
    transition_id:{type:'string',minLength:1,maxLength:256,pattern:'^\\S+$'},
    resume_ref:{type:'string',minLength:1,maxLength:512,pattern:'^\\S+$'},
    execution_result:{
      type:'object',
      required:['disposition'],
      properties:{
        disposition:{type:'string',enum:[...WORK_SETTLEMENT_DISPOSITIONS]},
        evidence:{type:'array',items:{type:'object',required:['kind','ref'],properties:{kind:{type:'string'},ref:{type:'string'}},additionalProperties:false}},
        reason:{type:['string','null']},
      },
      additionalProperties:false,
    },
  },
  additionalProperties:false,
});

const projectInspectSchema = Object.freeze({
  type:'object',
  required:['project_ref'],
  properties:{
    project_ref:{type:'string',pattern:'^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'},
  },
  additionalProperties:false,
});

const projectDefineSchema = Object.freeze({
  type:'object',
  required:['project_ref','expected_revision','definition'],
  properties:{
    project_ref:{type:'string',pattern:'^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'},
    expected_revision:{type:'string',pattern:'^[0-9a-fA-F]{40}$'},
    definition:{type:'object'},
  },
  additionalProperties:false,
});

const projectAmendSchema = Object.freeze({
  type:'object',
  required:['project_ref','expected_revision','amendment'],
  properties:{
    project_ref:{type:'string',pattern:'^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'},
    expected_revision:{type:'string',pattern:'^[0-9a-fA-F]{40}$'},
    amendment:{type:'object'},
  },
  additionalProperties:false,
});

function descriptor(
  command: string,
  mcpName: string,
  description: string,
  inputSchema: { readonly properties: Readonly<Record<string, unknown>>; readonly required?: readonly string[] } & Readonly<Record<string, unknown>>,
  surface: SemanticCommandSurface,
  exposure: SemanticCommandExposure = Object.freeze({ worker:true, mcp:true }),
): SemanticCommandDescriptor {
  return Object.freeze({
    command,
    mcp_name:mcpName,
    description,
    input_schema:inputSchema,
    semantic_fields:Object.freeze(Object.keys(inputSchema.properties)),
    required_fields:Object.freeze([...(inputSchema.required || [])]),
    exposure,
    surface,
  });
}

const INTERNAL_EXPOSURE = Object.freeze({ worker:true, mcp:false });
const WORKER_AND_MCP_EXPOSURE = Object.freeze({ worker:true, mcp:true });

const DESCRIPTORS = Object.freeze({
  'github.apply_changeset':descriptor(
    'github.apply_changeset',
    'github_apply_changeset',
    'Apply an exact repository changeset using only a valid project-transition lease as execution authority. Overcenter derives repository, managed workspace branch, immutable generation base, exact workspace-head fence, retry identity, and GitHub App credentials. Caller-selected Git coordinates are not accepted.',
    githubApplyChangesetSchema,
    'advanced',
    INTERNAL_EXPOSURE,
  ),
  'github.apply_text_replacements':descriptor(
    'github.apply_text_replacements',
    'github_apply_text_replacements',
    'Apply bounded exact text replacements under a project-transition lease. Source text is read from an immutable workspace revision and the later changeset is mechanically fenced to that same workspace observation, so stale reads fail closed before mutation. Repository, branch, head, retry identity, and credentials are derived internally.',
    githubApplyTextReplacementsSchema,
    'advanced',
    INTERNAL_EXPOSURE,
  ),
  'github.pull_request.mark_ready':descriptor(
    'github.pull_request.mark_ready',
    'github_pull_request_mark_ready',
    'Mark an exact-head draft pull request ready for review through the Overcenter GitHub App. The command fails closed if GitHub does not authorize the installation actor for this PR, never retries a mutation blindly, and authoritatively rereads state after uncertain mutation transport.',
    githubPullRequestMarkReadySchema,
    'advanced',
    INTERNAL_EXPOSURE,
  ),
  'github.release.create':descriptor(
    'github.release.create',
    'github_release_create',
    'Create an immutable lightweight Git tag at an exact observed Git commit and a GitHub Release for that tag. Fail closed on expected-state drift or conflicting existing state. Exact replay converges through durable idempotency evidence; no tag retargeting, release editing, deletion, asset upload, note generation, or commit inference is performed.',
    githubReleaseSchema,
    'advanced',
    INTERNAL_EXPOSURE,
  ),
  'orchestration.diagnose':descriptor(
    'orchestration.diagnose',
    'orchestration.diagnose',
    'Read current durable orchestration state and return the typed failure class, exact deterministic recovery operation, and escalation boundary. This is state inspection and recovery classification only; it does not plan or select work.',
    orchestrationDiagnoseSchema,
    'operator',
    INTERNAL_EXPOSURE,
  ),
  'production.reconcile':descriptor(
    'production.reconcile',
    'production.reconcile',
    'Converge the repository\'s verified development revision into declared production state by repository identity only. Overcenter derives branch roles, exact revisions, verification, promotion, serialized runtime materialization, recovery, and final same-revision evidence.',
    productionReconcileSchema,
    'primary',
    WORKER_AND_MCP_EXPOSURE,
  ),
  'production.promote':descriptor(
    'production.promote',
    'production.promote',
    'Promote the current verified development revision by repository identity only. The runtime host derives provider-specific branch heads, exact-revision evidence, retry identity, and production readback behind this primary semantic boundary.',
    productionPromoteSchema,
    'primary',
    WORKER_AND_MCP_EXPOSURE,
  ),
  'project.advance':descriptor(
    'project.advance',
    'project.advance',
    'Advance authoritative repository-owned project work in an independent agent session. Omit transition_id for deterministic best-available selection, or nominate one exact transition without fallback. Resume by passing the durable resume_ref returned by a prior call; when agent execution is complete, return its bounded execution_result through this same command. Overcenter owns run identity, lease acquisition, settlement, exact authority, recovery, and continuation.',
    projectAdvanceSchema,
    'primary',
    WORKER_AND_MCP_EXPOSURE,
  ),
  'project.inspect':descriptor(
    'project.inspect',
    'project.inspect',
    'Inspect authoritative repository-owned project state by project identity only. The runtime adapter derives the exact GitHub authority revision and graph frontier while keeping repository layout and host-specific runtime coordinates outside the primary semantic intent.',
    projectInspectSchema,
    'primary',
    WORKER_AND_MCP_EXPOSURE,
  ),
  'release.publish':descriptor(
    'release.publish',
    'release.publish',
    'Publish one exact verified semantic release plan. The caller supplies only the plan and release notes; Overcenter revalidates current Git authority and repository-owned transition impacts, derives provider release bookkeeping, invokes the immutable release primitive, and returns verified publication evidence.',
    releasePublishSchema,
    'primary',
    WORKER_AND_MCP_EXPOSURE,
  ),
  'work.settle':descriptor(
    'work.settle',
    'work.settle',
    'Truthfully consume one valid work lease as completed, requeue, or blocked. Supply the non-secret lease_ref plus settlement semantics; lease capability lookup, run correlation, and deterministic retry identity are derived internally.',
    workSettleSchema,
    'compatibility',
    INTERNAL_EXPOSURE,
  ),
});

const PROJECT_AUTHORING_DESCRIPTORS = Object.freeze({
  'project.define':descriptor(
    'project.define',
    'project.define',
    'Define canonical repository-owned project graph facts at an exact observed Git revision. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.',
    projectDefineSchema,
    'primary',
    WORKER_AND_MCP_EXPOSURE,
  ),
  'project.amend':descriptor(
    'project.amend',
    'project.amend',
    'Amend canonical repository-owned project graph facts at an exact observed Git revision using semantic transition intent. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.',
    projectAmendSchema,
    'primary',
    WORKER_AND_MCP_EXPOSURE,
  ),
});

const ALL_DESCRIPTORS = Object.freeze({ ...DESCRIPTORS, ...PROJECT_AUTHORING_DESCRIPTORS });

export const MIGRATED_SEMANTIC_COMMANDS = Object.freeze(Object.keys(ALL_DESCRIPTORS));

export function semanticCommandDescriptor(command: string): SemanticCommandDescriptor {
  if (!Object.prototype.hasOwnProperty.call(ALL_DESCRIPTORS, command)) {
    throw new Error(`Semantic command descriptor is not migrated: ${command}`);
  }
  return ALL_DESCRIPTORS[command as keyof typeof ALL_DESCRIPTORS];
}

export function semanticCommandDescriptorsForSurface(surface: SemanticCommandSurface): readonly SemanticCommandDescriptor[] {
  return Object.freeze(
    MIGRATED_SEMANTIC_COMMANDS
      .map((command) => semanticCommandDescriptor(command))
      .filter((descriptor) => descriptor.surface === surface && descriptor.exposure.mcp),
  );
}

export function semanticMcpDiscoveryForSurface(surface: SemanticCommandSurface): readonly SemanticMcpDiscoveryEntry[] {
  return Object.freeze(
    semanticCommandDescriptorsForSurface(surface).map((descriptor) => Object.freeze({
      command: descriptor.command,
      name: descriptor.mcp_name,
      description: descriptor.description,
      input_schema: descriptor.input_schema,
    })),
  );
}
