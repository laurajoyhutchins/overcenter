import {
  promoteProduction,
  type ProductionPromotionPorts,
} from '../src/semantic/production-promotion-operation';

const calls: string[] = [];

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
  promoteVerifiedRevision: async (request) => {
    const verificationRef: string = request.verification_ref;
    calls.push(`promote:${request.repo}:${request.source_revision}:${request.production_revision}:${verificationRef}`);
    return { production_revision: request.source_revision };
  },
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