import type {
  OperatingCondition,
  ProductiveStage,
  WorkRequeueClass,
  WorkSettlementDisposition,
} from './execution-lifecycle-contracts.js';
import type { MutationCertainty } from './mutation-certainty.js';
import { semanticCommandDescriptor } from './semantic-command-descriptors.js';

export interface WorkSettleEvidenceRef {
  readonly kind: string;
  readonly ref: string;
}

export interface WorkLifecycleResponsibility {
  readonly applicable: boolean;
  readonly satisfied: boolean;
}

export type WorkLifecycleResponsibilities = Partial<Record<ProductiveStage, WorkLifecycleResponsibility>>;

export interface WorkLifecycleFacts {
  readonly condition?: OperatingCondition;
  readonly responsibilities?: WorkLifecycleResponsibilities;
}

export interface WorkSettleInput {
  readonly lease_ref: string;
  readonly disposition: WorkSettlementDisposition;
  readonly evidence?: readonly WorkSettleEvidenceRef[];
  readonly reason?: string | null;
  readonly promotion_condition?: string | null;
  readonly requeue_class?: WorkRequeueClass | null;
  readonly operating_condition?: OperatingCondition | null;
  readonly continuation?: Readonly<Record<string, unknown>> | null;
  readonly lifecycle_facts?: WorkLifecycleFacts | null;
}

export interface AuthoritativeEffectConfirmation {
  readonly confirmed?: boolean;
  readonly evidence?: readonly WorkSettleEvidenceRef[];
  readonly reason?: string | null;
  readonly mutation_certainty?: MutationCertainty;
  readonly may_have_mutated?: boolean;
}

type AuthoritativeEffectSettlementInput = Readonly<{
  disposition: WorkSettlementDisposition;
  evidence?: readonly WorkSettleEvidenceRef[];
}>;

type AuthoritativeEffectSettlementError = Error & {
  code: string;
  details: Readonly<Record<string, unknown>>;
  may_have_mutated: boolean;
};

const CANDIDATE_EVIDENCE_KINDS = Object.freeze(new Set([
  'candidate_revision',
  'candidate',
  'verified_candidate',
]));

function evidenceKind(value: unknown): string {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? String((value as Readonly<Record<string, unknown>>).kind || '').trim().toLowerCase()
    : '';
}

export function settlementRequiresAuthoritativeEffect(input: AuthoritativeEffectSettlementInput): boolean {
  return input?.disposition === 'completed'
    && (input?.evidence || []).some((entry) => CANDIDATE_EVIDENCE_KINDS.has(evidenceKind(entry)));
}

function unconfirmedAuthoritativeEffect(confirmation: AuthoritativeEffectConfirmation | null): never {
  const mayHaveMutated = confirmation?.mutation_certainty === 'possible' || confirmation?.may_have_mutated === true;
  const error = new Error(
    'verified candidate evidence cannot complete a project transition before deterministic authoritative-provider confirmation',
  ) as AuthoritativeEffectSettlementError;
  error.code = 'PROJECT_ADVANCE_AUTHORITATIVE_EFFECT_UNCONFIRMED';
  error.may_have_mutated = mayHaveMutated;
  error.details = Object.freeze({
    may_have_mutated:mayHaveMutated,
    required_continuation:'deterministic_authoritative_effect_reconciliation',
    ...(confirmation?.reason ? { confirmation_reason:String(confirmation.reason) } : {}),
  });
  throw error;
}

export function bindAuthoritativeEffectSettlement(
  input: AuthoritativeEffectSettlementInput,
  confirmation: AuthoritativeEffectConfirmation | null = null,
): readonly WorkSettleEvidenceRef[] {
  const evidence = input?.evidence || [];
  if (!settlementRequiresAuthoritativeEffect(input)) return evidence;
  if (confirmation?.confirmed !== true) unconfirmedAuthoritativeEffect(confirmation);
  const confirmedEvidence = Array.isArray(confirmation.evidence) ? confirmation.evidence : [];
  if (!confirmedEvidence.some((entry) => evidenceKind(entry) === 'authority_readback')) {
    unconfirmedAuthoritativeEffect({ ...confirmation, reason:'authoritative_readback_missing' });
  }
  return Object.freeze([...evidence, ...confirmedEvidence]);
}

const descriptor = semanticCommandDescriptor('work.settle');

export const WORK_SETTLE_INPUT_SCHEMA = descriptor.input_schema;
export const WORK_SETTLE_SEMANTIC_FIELDS = descriptor.semantic_fields;
export const WORK_SETTLE_REQUIRED_FIELDS = descriptor.required_fields;
