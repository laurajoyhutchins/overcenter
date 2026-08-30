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

export type ProductionPromotionWriteResult = Readonly<{
  production_revision: string;
}>;

export type ProductionPromotionResult = Readonly<{
  ok: true;
  repo: string;
  source_revision: string;
  production_revision: string;
  verification_ref: string;
}>;

export type ProductionPromotionPorts = Readonly<{
  resolveBranchRoles(repo: string): Promise<ProductionBranchRoles>;
  readBranchHead(repo: string, branch: string): Promise<string>;
  verifyExactRevision(repo: string, revision: string): Promise<ExactRevisionVerification>;
  promoteVerifiedRevision(request: VerifiedProductionPromotionRequest): Promise<ProductionPromotionWriteResult>;
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
    throw new Error('PRODUCTION_PROMOTION_SOURCE_NOT_VERIFIED');
  }

  const promoted = await ports.promoteVerifiedRevision({
    repo: intent.repo,
    source_revision: sourceRevision,
    production_revision: productionRevision,
    verification_ref: verification.verification_ref,
  });

  return {
    ok: true,
    repo: intent.repo,
    source_revision: sourceRevision,
    production_revision: promoted.production_revision,
    verification_ref: verification.verification_ref,
  };
}
