import { executeCommand } from 'lib/command-response.js';
import { reconcilePortfolioWorkSurfaceWithGitHubApp } from 'lib/portfolio-reconcile-work-surface.js';

export const access = 'admin';

export default {
  name: 'portfolio_reconcile_work_surface',
  description: 'Reconcile explicitly selected GitHub issue demand onto the Portfolio Orchestration Linear execution surface without ranking, selecting, or interpreting work.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['project', 'items'],
    properties: {
      project: { type: 'string', enum: ['Portfolio Orchestration'] },
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
              },
            },
            projection: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'state', 'lane', 'priority', 'objective', 'gate', 'acceptance'],
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 255 },
                state: { type: 'string', enum: ['Todo', 'Backlog'] },
                lane: { type: 'string', enum: ['lane:repo-implementation', 'lane:source-implementation', 'lane:verification', 'lane:integration'] },
                priority: { type: 'integer', minimum: 0, maximum: 4 },
                objective: { type: 'string', minLength: 1, maxLength: 4000 },
                gate: { type: 'string', minLength: 1, maxLength: 2000 },
                acceptance: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 20,
                  items: { type: 'string', minLength: 1, maxLength: 1000 },
                },
                repository: { type: ['string', 'null'], maxLength: 256, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
                exact_coordinate: { type: ['string', 'null'], maxLength: 1000 },
                owner_impact: { type: ['string', 'null'], maxLength: 500 },
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
      dry_run: { type: 'boolean' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCommand(
      'portfolio.reconcile_work_surface',
      () => reconcilePortfolioWorkSurfaceWithGitHubApp(args),
      { flattenDetails: true },
    );
    return response.body;
  },
};