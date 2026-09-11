import {
  promoteProduction,
  type ProductionPromotionFailure,
  type ProductionPromotionPorts,
  type ProductionPromotionPayload,
  type ProductionBranchRoles,
  type VerifiedProductionPromotionRequest,
} from '../src/semantic/production-promotion-operation';
import type { ExecutionTransactionContext } from '../src/semantic/execution-transaction-runtime';
import type { ExecutionTransactionStore } from '../src/semantic/execution-transaction-store';
import type { ProviderEffect } from '../src/semantic/execution-transaction';

const calls: string[] = [];

const executionTransactionStore = {} as ExecutionTransactionStore;
const ports: ProductionPromotionPorts = {
  resolveBranchRoles: async (repo) => {
    calls.push(`roles:${repo}`);
    return { development: 'dev', production: 'main' };
  },
  readBranchHead: async (repo, branch) => {
    calls.push(`head:${repo}:${branch}`);
    return branch === 'dev' ? 'a'.repeat(40) : 'b'.repeat(40);
  },
  verifyExactRevision: async (repo, revision) => {
    calls.push(`verify:${repo}:${revision}`);
    return { revision, verified: true, verification_ref: 'verification:opaque:123' };
  },
  executionTransactionStore,
  executionContext: (_request: VerifiedProductionPromotionRequest): ExecutionTransactionContext => ({
    run_id: 'production-promotion-type-test',
    subject_kind: 'provider_operation',
    lease_expires_at: '2999-01-01T00:00:00.000Z',
  }),
  providerFor: (_request: VerifiedProductionPromotionRequest, _roles: ProductionBranchRoles): ProviderEffect<ProductionPromotionPayload> => ({
    async preflight() {
      return { provider: 'type-test', observed_revision: 'a'.repeat(40), provider_identity: {} };
    },
    async invoke() {
      return { transport: 'accepted', committed: true, effect_ref: 'effect', response_sha256: 'response', evidence: {} };
    },
    async confirm() {
      return { status: 'confirmed', effect_ref: 'effect', predicate: 'type-test', evidence: {} };
    },
  }),
};

const result = await promoteProduction({ repo: 'laurajoyhutchins/overcenter' }, ports);
const sourceRevision: string = result.source_revision;
const previousProductionRevision: string = result.previous_production_revision;
const productionRevision: string = result.production_revision;
const verificationRef: string = result.verification_ref;
void sourceRevision;
void previousProductionRevision;
void productionRevision;
void verificationRef;
void calls;

let observedFailure: ProductionPromotionFailure | null = null;
try {
  await promoteProduction({ repo: 'laurajoyhutchins/overcenter' }, {
    ...ports,
    verifyExactRevision: async (_repo, revision) => ({
      revision,
      verified: false,
      verification_ref: '',
    }),
  });
} catch (error) {
  observedFailure = error as ProductionPromotionFailure;
}
if (!observedFailure) throw new Error('expected production promotion verification failure');
const failureCode: ProductionPromotionFailure['code'] = observedFailure.code;
const failureMutation: false = observedFailure.may_have_mutated;
void failureCode;
void failureMutation;