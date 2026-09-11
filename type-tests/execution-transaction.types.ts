import type {
  ProviderEffectPayload,
  SettlementReceipt,
} from '../src/semantic/execution-transaction.js';

const safePayload: ProviderEffectPayload<{ readonly action: string }> = {
  action: 'publish',
};
void safePayload;

type InvalidPayload = ProviderEffectPayload<{ readonly lease_ref: string }>;
// @ts-expect-error provider payload cannot own lease identity
const invalidLease: InvalidPayload = { lease_ref: 'worker-supplied' };
void invalidLease;

type InvalidAuthorityPayload = ProviderEffectPayload<{ readonly authority_epoch: number }>;
// @ts-expect-error provider payload cannot own authority fencing
const invalidAuthority: InvalidAuthorityPayload = { authority_epoch: 7 };
void invalidAuthority;

const receipt: SettlementReceipt = {
  schema: 'settlement-receipt-v1',
  execution_id: 'execution-1',
  operation_id: 'operation-1',
  authority_revision: 'a'.repeat(40),
  authority_epoch: 1,
  lifecycle: 'settled',
  disposition: 'completed',
  effect_ref: 'provider-effect-1',
  evidence_sha256: 'evidence-hash',
};
void receipt;

// @ts-expect-error a settlement receipt cannot omit its execution identity
const incompleteReceipt: SettlementReceipt = {
  schema: 'settlement-receipt-v1',
  operation_id: 'operation-1',
  authority_revision: 'a'.repeat(40),
  authority_epoch: 1,
  lifecycle: 'settled',
  disposition: 'completed',
  effect_ref: null,
  evidence_sha256: 'evidence-hash',
};
void incompleteReceipt;
