import { createProductionPromotionMcpBinding } from '../src/adapters/mcp/production-promotion';

const sourceRevision = 'a'.repeat(40);
const previousProductionRevision = 'b'.repeat(40);
const binding = createProductionPromotionMcpBinding({
  promote: async ({ repo }) => ({
    source_revision: repo.length === 0 ? '' : sourceRevision,
    previous_production_revision: previousProductionRevision,
    production_revision: sourceRevision,
    verification_ref: 'verification:opaque:123',
  }),
});

const result = await binding({ repo: 'laurajoyhutchins/overcenter' });
const exactSourceRevision: string = result.source_revision;
const exactPreviousProductionRevision: string = result.previous_production_revision;
const productionRevision: string = result.production_revision;
const verificationRef: string = result.verification_ref;
void exactSourceRevision;
void exactPreviousProductionRevision;
void productionRevision;
void verificationRef;