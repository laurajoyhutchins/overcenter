import type { ExecutionTransactionContext } from '../semantic/execution-transaction-runtime.js';
import type { ExecutionTransactionStore } from '../semantic/execution-transaction-store.js';
import type {
  ExactRevisionVerification,
  ProductionBranchRoles,
  ProductionPromotionPayload,
  VerifiedProductionPromotionRequest,
} from '../semantic/production-promotion-operation.js';
import type { ProviderEffect } from '../semantic/execution-transaction.js';

export type ProductionPromotionRuntimeHost = Readonly<{
  resolveBranchRoles(repo: string): Promise<ProductionBranchRoles>;
  readBranchHead(repo: string, branch: string): Promise<string>;
  verifyExactRevision(repo: string, revision: string): Promise<ExactRevisionVerification>;
  readonly executionTransactionStore: ExecutionTransactionStore;
  executionContext(input: VerifiedProductionPromotionRequest): ExecutionTransactionContext;
  providerFor(
    input: VerifiedProductionPromotionRequest,
    roles: ProductionBranchRoles,
  ): ProviderEffect<ProductionPromotionPayload>;
}>;
