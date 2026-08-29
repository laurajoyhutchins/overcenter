import type { CanonicalCommand } from './canonical-commands.js';

export const EXECUTION_EVIDENCE_SCHEMA = 'execution-evidence-v1' as const;

export const MUTATION_CERTAINTIES = [
  'not_applicable',
  'confirmed_present',
  'definitively_absent',
  'unknown',
] as const;
export type MutationCertainty = (typeof MUTATION_CERTAINTIES)[number];

export const NO_EXTERNAL_MUTATION_COMMANDS = [
  'github.review_packet',
  'github.capabilities',
  'work.checkpoint',
  'work.heartbeat',
  'skill.activate',
  'skill.complete',
  'orchestration.start',
  'orchestration.horizon_checkpoint',
  'orchestration.horizon_resolve',
  'orchestration.finish',
  'orchestration.maintain',
  'orchestration.resume_packet',
  'orchestration.diagnose',
  'orchestration.status',
] as const satisfies readonly CanonicalCommand[];

export const VERIFIED_EXTERNAL_EFFECT_COMMANDS = [
  'github.repository_metadata.ensure',
  'github.repository_template.ensure',
  'github.repository_from_template.create',
  'github.milestone.ensure',
  'github.release.create',
  'github.required_checks.ensure',
] as const satisfies readonly CanonicalCommand[];

export interface EvidenceRef {
  readonly kind: string;
  readonly ref: string;
}

export interface AuthorityAfterEvidence {
  readonly state: string | null;
  readonly lane: string | null;
  readonly revision: string | null;
  readonly execution_fingerprint: string | null;
}

export interface SettlementEvidence {
  readonly lease_id: string | null;
  readonly source_ref: string | null;
  readonly work_ref: string | null;
  readonly gate: string | null;
  readonly settlement_disposition: string | null;
  readonly settled_at: string | null;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly authority_after: AuthorityAfterEvidence;
  readonly execution_precondition_verified: boolean;
}

export interface CommandEvidence {
  readonly invocation_id: string | null;
  readonly source_ref: string | null;
  readonly sequence: number | null;
  readonly command: string | null;
  readonly target: Readonly<{ kind: string | null; ref: string | null }>;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly outcome: string | null;
  readonly error: Readonly<{
    code: string | null;
    class: string | null;
    retryable: boolean | null;
    rejection: boolean | null;
  }>;
  readonly may_have_mutated: boolean | null;
  readonly request_sha256: string | null;
  readonly result_sha256: string | null;
  readonly request: unknown;
  readonly result: unknown;
  readonly effect: Readonly<{ mutation_certainty: MutationCertainty }>;
  readonly resolution_refs: readonly string[];
}

export interface ExecutionEvidence {
  readonly schema: typeof EXECUTION_EVIDENCE_SCHEMA;
  readonly run: unknown;
  readonly target: unknown;
  readonly work_observations: readonly unknown[];
  readonly leases: readonly unknown[];
  readonly checkpoints: readonly unknown[];
  readonly commands: readonly CommandEvidence[];
  readonly settlements: readonly SettlementEvidence[];
  readonly verifications: readonly unknown[];
  readonly recoveries: readonly unknown[];
  readonly integrity: Readonly<{ status: 'not_evaluated'; violations: readonly unknown[] }>;
}
