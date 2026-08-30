import { semanticCommandDescriptor } from '../src/semantic/semantic-command-descriptors';
import { createProductionPromotionMcpBinding } from '../src/runtime/production-promotion-mcp-binding';

const descriptor = semanticCommandDescriptor('production.promote');
const exposed: true = descriptor.exposure.mcp;
const binding = createProductionPromotionMcpBinding({
  promote: async ({ repo }) => ({ production_revision: repo.length === 0 ? '' : 'a'.repeat(40) }),
});

const result = await binding({ repo: 'laurajoyhutchins/overcenter' });
const productionRevision: string = result.production_revision;
void exposed;
void productionRevision;
