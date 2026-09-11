import { promoteProduction, type ProductionPromotionPayload } from '../src/semantic/production-promotion-operation';
import { createProductionPromotionPorts } from '../src/adapters/production-promotion/runtime-adapter';
import type { ExecutionTransactionContext } from '../src/semantic/execution-transaction-runtime';
import type { ExecutionTransactionStore } from '../src/semantic/execution-transaction-store';
import type { ProviderEffect } from '../src/semantic/execution-transaction';
import type { ProductionPromotionRuntimeHost } from '../src/ports/production-promotion-runtime-host';

const strictRequests: Array<{
  repo: string;
  candidate_sha: string;
  observed_development_head: string;
  observed_production_head: string;
  verification_run_id: number;
  idempotency_key: string;
}> = [];

const host: ProductionPromotionRuntimeHost = {
  resolveBranchRoles: async () => ({ development: 'dev', production: 'main' }),
  readBranchHead: async (_repo, branch) => branch === 'dev' ? 'a'.repeat(40) : 'b'.repeat(40),
  verifyExactRevision: async (_repo, revision) => ({
    revision,
    verified: true,
    verification_ref: 'verification:opaque:run-42',
  }),
  executionTransactionStore: {} as ExecutionTransactionStore,
  executionContext: () => ({
    run_id: 'production-promotion-adapter-type-test',
    subject_kind: 'provider_operation',
    lease_expires_at: '2999-01-01T00:00:00.000Z',
  } satisfies ExecutionTransactionContext),
  providerFor: () => ({
    async preflight() {
      return { provider:'type-test', observed_revision:'a'.repeat(40), provider_identity:{} };
    },
    async invoke() {
      strictRequests.push({
        repo:'owner/repo',
        candidate_sha:'a'.repeat(40),
        observed_development_head:'a'.repeat(40),
        observed_production_head:'b'.repeat(40),
        verification_run_id:42,
        idempotency_key:'type-test',
      });
      return { transport:'accepted', committed:true, effect_ref:'effect', response_sha256:'response', evidence:{} };
    },
    async confirm() {
      return { status:'confirmed', effect_ref:'effect', predicate:'type-test', evidence:{} };
    },
  } satisfies ProviderEffect<ProductionPromotionPayload>),
};

const result = await promoteProduction(
  { repo: 'laurajoyhutchins/overcenter' },
  createProductionPromotionPorts(host),
);

const promotedRevision: string = result.production_revision;
const verificationRunId: number = strictRequests[0]!.verification_run_id;
void promotedRevision;
void verificationRunId;