import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { reconcilePortfolioWorkSurfaceWithGitHubApp } from 'lib/portfolio-reconcile-work-surface.js';

export const access = 'admin';

export default {
  name: 'portfolio_reconcile_work_surface',
  description: 'Project bounded executable work into Linear. Admission, eviction, repository disposition, canonical identity, and frontier limits are machine-enforced; GitHub issue existence alone is not sufficient.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['project', 'items'],
    properties: {
      project: { type: 'string', minLength: 1, maxLength: 128, description: 'Target Linear campaign project name.' },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 25,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'projection'],
          properties: {
            source: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'repo', 'issue_number'],
              properties: {
                kind: { type: 'string', enum: ['github_issue'] },
                repo: { type: 'string', minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
                issue_number: { type: 'integer', minimum: 1 },
                expected_revision: { type: ['string', 'null'], maxLength: 128 },
                unit_key: { type: ['string', 'null'], maxLength: 256, description: 'Stable bounded-unit key when one authoritative roadmap issue backs multiple execution units.' },
                canonical_key: { type: ['string', 'null'], maxLength: 256, description: 'Stable executable identity shared by duplicate source observations of the same bounded outcome.' },
              },
            },
            projection: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'lane', 'priority', 'outcome', 'next_action', 'actor', 'changes_authority_or_produces_evidence', 'disposition'],
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 255 },
                lane: { type: 'string', enum: ['lane:repo-implementation', 'lane:source-implementation', 'lane:verification', 'lane:integration'] },
                priority: { type: 'integer', minimum: 0, maximum: 4 },
                outcome: { type: 'string', minLength: 1, maxLength: 4000, description: 'One bounded executable result.' },
                next_action: { type: 'string', minLength: 1, maxLength: 2000, description: 'The concrete action an available actor can perform next.' },
                actor: { type: 'string', enum: ['worker', 'human', 'external', 'deterministic', 'none'] },
                changes_authority_or_produces_evidence: { type: 'boolean' },
                disposition: { type: 'string', enum: ['KEEP_EXECUTABLE', 'BLOCKED_EXTERNAL', 'WAITING_HUMAN', 'DERIVED_STATE', 'HISTORICAL_REFERENCE', 'SUPERSEDED', 'DUPLICATE', 'DISPOSED_REPOSITORY', 'NO_EXECUTABLE_ACTION'] },
                authoritative_complete: { type: 'boolean', description: 'True only when the real authority proves the bounded outcome complete.' },
                dependencies: {
                  type: 'array',
                  maxItems: 25,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'ref'],
                    properties: {
                      kind: { type: 'string', enum: ['linear_issue'] },
                      ref: { type: 'string', minLength: 1, maxLength: 128 },
                    },
                  },
                },
                promotion_condition: { type: ['string', 'null'], maxLength: 2000 },
              },
            },
          },
        },
      },
      idempotency_key: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
      frontier_limit: { type: ['integer', 'null'], minimum: 1, maximum: 25, description: 'Optional explicit active-frontier bound. Omit to use the configured project bound.' },
      dry_run: { type: 'boolean' },
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional orchestration run token used only for correlation and excluded from the reconciliation semantic request hash.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'portfolio.reconcile_work_surface',
      args || {},
      (input) => reconcilePortfolioWorkSurfaceWithGitHubApp(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};