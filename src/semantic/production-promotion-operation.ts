import { canonicalJson, sha256Text } from './canonical-json.js';
import {
  executeExecutionTransaction,
  type ExecutionTransactionContext,
} from './execution-transaction-runtime.js';
import type { ExecutionTransactionStore } from './execution-transaction-store.js';
import type { ProviderEffect } from './execution-transaction.js';
import type { ProductionPromotionIntent } from './production-promotion-intent.js';

export type ProductionBranchRoles = Readonly<{
  development: string;
  production: string;
}>;

export type ExactRevisionVerification = Readonly<{
  revision: string;
  verified: boolean;
  verification_ref: string;
}>;

export type VerifiedProductionPromotionRequest = Readonly<{
  repo: string;
  source_revision: string;
  production_revision: string;
  verification_ref: string;
}>;

export type ProductionPromotionPayload = Readonly<{
  repo: string;
  development_branch: string;
  production_branch: string;
  source_revision: string;
  production_revision: string;
  verification_ref: string;
}>;

export type ProductionPromotionOutcome = Readonly<{
  production_revision: string;
}>;

export type ProductionPromotionResult = Readonly<{
  source_revision: string;
  previous_production_revision: string;
  production_revision: string;
  verification_ref: string;
}>;

export type ProductionPromotionFailureCode =
  | 'PRODUCTION_PROMOTION_SOURCE_NOT_VERIFIED'
  | 'PRODUCTION_PROMOTION_NOT_COMPLETED';

export class ProductionPromotionFailure extends Error {
  readonly code: ProductionPromotionFailureCode;
  readonly may_have_mutated: false;

  constructor(code: ProductionPromotionFailureCode) {
    super(code);
    this.name = 'ProductionPromotionFailure';
    this.code = code;
    this.may_have_mutated = false;
  }
}

export type ProductionPromotionPorts = Readonly<{
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

function promotionPayload(
  request: VerifiedProductionPromotionRequest,
  roles: ProductionBranchRoles,
): ProductionPromotionPayload {
  return Object.freeze({
    repo: request.repo,
    development_branch: roles.development,
    production_branch: roles.production,
    source_revision: request.source_revision,
    production_revision: request.production_revision,
    verification_ref: request.verification_ref,
  });
}

async function promotionIdempotencyKey(
  request: VerifiedProductionPromotionRequest,
): Promise<string> {
  const digest = await sha256Text(canonicalJson(request));
  return `production-promote:${digest}`;
}

export async function promoteProduction(
  intent: ProductionPromotionIntent,
  ports: ProductionPromotionPorts,
): Promise<ProductionPromotionResult> {
  const roles = await ports.resolveBranchRoles(intent.repo);
  const sourceRevision = await ports.readBranchHead(intent.repo, roles.development);
  const productionRevision = await ports.readBranchHead(intent.repo, roles.production);
  const verification = await ports.verifyExactRevision(intent.repo, sourceRevision);

  if (
    !verification.verified
    || verification.revision !== sourceRevision
    || verification.verification_ref.trim().length === 0
  ) {
    throw new ProductionPromotionFailure('PRODUCTION_PROMOTION_SOURCE_NOT_VERIFIED');
  }

  const request = Object.freeze({
    repo: intent.repo,
    source_revision: sourceRevision,
    production_revision: productionRevision,
    verification_ref: verification.verification_ref,
  });
  const projectRef = `github:${intent.repo}`;
  const transactionIntent = {
    project_ref: projectRef,
    subject_key: `${projectRef}:production`,
    authority: {
      project_ref: projectRef,
      repository: intent.repo,
      revision: sourceRevision,
      epoch: 0,
      graph_fingerprint: `github.branch-roles:${roles.development}:${roles.production}`,
      transition_fingerprint: `production-promotion:${sourceRevision}:${productionRevision}`,
    },
    operation: {
      kind: 'github.production.promote',
      idempotency_scope: `repository:${intent.repo}`,
      idempotency_key: await promotionIdempotencyKey(request),
      payload: promotionPayload(request, roles),
    },
  } as const;

  const transaction = await executeExecutionTransaction({
    intent: transactionIntent,
    context: ports.executionContext(request),
    provider: ports.providerFor(request, roles),
    store: ports.executionTransactionStore,
  });
  if (transaction.receipt.disposition !== 'completed') {
    throw new ProductionPromotionFailure('PRODUCTION_PROMOTION_NOT_COMPLETED');
  }

  return Object.freeze({
    source_revision: sourceRevision,
    previous_production_revision: productionRevision,
    production_revision: sourceRevision,
    verification_ref: verification.verification_ref,
  });
}
