import { createProductionPromotionMcpBinding } from '../src/runtime/production-promotion-mcp-binding';

const sourceRevision = 'a'.repeat(40);
const binding = createProductionPromotionMcpBinding({
  promote: async ({ repo }) => ({
    ok: true,
    repo,
    source_revision: sourceRevision,
    production_revision: sourceRevision,
    verification_ref: 'github-actions-run:12345',
  }),
});

const result = await binding({ repo: 'laurajoyhutchins/overcenter' });
const ok: true = result.ok;
const repo: string = result.repo;
const source: string = result.source_revision;
const production: string = result.production_revision;
const verificationRef: string = result.verification_ref;
void ok;
void repo;
void source;
void production;
void verificationRef;
