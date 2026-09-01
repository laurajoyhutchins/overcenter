import type {
  ExactRevisionVerification,
  ProductionBranchRoles,
  ProductionPromotionOutcome,
  VerifiedProductionPromotionRequest,
} from '../semantic/production-promotion-operation.js';

export type StrictProductionPromotionRequest = Readonly<{
  repo: string;
  candidate_sha: string;
  observed_development_head: string;
  observed_production_head: string;
  verification_run_id: number;
  idempotency_key: string;
}>;

export type ProductionPromotionVerificationEvidence = Readonly<{
  verification_run_id: number;
}>;

export type ProductionPromotionRuntimeHost = Readonly<{
  resolveBranchRoles(repo: string): Promise<ProductionBranchRoles>;
  readBranchHead(repo: string, branch: string): Promise<string>;
  verifyExactRevision(repo: string, revision: string): Promise<ExactRevisionVerification>;
  resolveVerificationEvidence(verificationRef: string): Promise<ProductionPromotionVerificationEvidence>;
  deriveIdempotencyKey(request: VerifiedProductionPromotionRequest): Promise<string>;
  invokeStrictPromotion(request: StrictProductionPromotionRequest): Promise<ProductionPromotionOutcome>;
}>;