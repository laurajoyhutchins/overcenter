import type { ProductionPromotionIntent } from './production-promotion-intent';

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

export type ProductionPromotionOutcome = Readonly<{
  production_revision: string;
}>;

export type ProductionPromotionResult = Readonly<{
  source_revision: string;
  previous_production_revision: string;
  production_revision: string;
  verification_ref: string;
}>;

export type ProductionPromotionFailureCode = 'PRODUCTION_PROMOTION_SOURCE_NOT_VERIFIED';

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
  promoteVerifiedRevision(request: VerifiedProductionPromotionRequest): Promise<ProductionPromotionOutcome>;
}>;

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

  const promotion = await ports.promoteVerifiedRevision({
    repo: intent.repo,
    source_revision: sourceRevision,
    production_revision: productionRevision,
    verification_ref: verification.verification_ref,
  });

  return Object.freeze({
    source_revision: sourceRevision,
    previous_production_revision: productionRevision,
    production_revision: promotion.production_revision,
    verification_ref: verification.verification_ref,
  });
}