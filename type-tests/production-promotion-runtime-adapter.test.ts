import { promoteProduction } from '../src/semantic/production-promotion-operation';
import { createProductionPromotionPorts } from '../src/adapters/production-promotion/runtime-adapter';
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
  resolveVerificationEvidence: async (verificationRef) => {
    const ref: string = verificationRef;
    void ref;
    return { verification_run_id: 42 };
  },
  deriveIdempotencyKey: async (request) => `production:${request.repo}:${request.source_revision}`,
  invokeStrictPromotion: async (request) => {
    strictRequests.push(request);
    return { production_revision: request.candidate_sha };
  },
};

const result = await promoteProduction(
  { repo: 'laurajoyhutchins/overcenter' },
  createProductionPromotionPorts(host),
);

const promotedRevision: string = result.production_revision;
const verificationRunId: number = strictRequests[0]!.verification_run_id;
void promotedRevision;
void verificationRunId;