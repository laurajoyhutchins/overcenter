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
    return { revision, verified: true };
  },
  promoteVerifiedRevision: async (request) => {
    calls.push(`promote:${request.repo}:${request.source_revision}:${request.production_revision}`);
    return { production_revision: request.source_revision };
  },
};

const result = await promoteProduction({ repo: 'laurajoyhutchins/overcenter' }, ports);
const productionRevision: string = result.production_revision;
void productionRevision;
void calls;