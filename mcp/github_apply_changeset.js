import { applyGithubChangesetWithGitHubApp } from 'lib/github-apply-changeset.js';

export const access = 'admin';

export default {
  name: 'github_apply_changeset',
  description: 'Atomically apply a declared multi-file UTF-8 repository changeset as one Git commit using GitHub Git Data APIs. Supports create/update/delete, optimistic expected_head checks, non-force branch updates, and exact idempotent replay. This is the Hatchable-safe tool name for the conceptual github.apply_changeset command.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'branch', 'changes', 'commit_message'],
    additionalProperties: false,
    oneOf: [
      { required: ['base_ref'], not: { required: ['base_sha'] } },
      { required: ['base_sha'], not: { required: ['base_ref'] } },
    ],
    properties: {
      repo: {
        type: 'string',
        minLength: 3,
        maxLength: 256,
        pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
        description: 'Repository in owner/repo form.',
      },
      base_ref: {
        type: 'string',
        minLength: 1,
        maxLength: 1024,
        description: 'Branch, tag, or commit-ish used to seed a new target branch. Provide exactly one of base_ref or base_sha.',
      },
      base_sha: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{40}$',
        description: 'Explicit full commit SHA used to seed a new target branch. Provide exactly one of base_ref or base_sha.',
      },
      branch: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description: 'Target branch to create or fast-forward.',
      },
      expected_head: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{40}$',
        description: 'Optimistic concurrency precondition. Existing branch: current branch head. New branch: resolved base commit.',
      },
      changes: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['path', 'operation'],
          additionalProperties: false,
          allOf: [
            {
              if: { properties: { operation: { enum: ['create', 'update'] } }, required: ['operation'] },
              then: { required: ['content'] },
            },
            {
              if: { properties: { operation: { const: 'delete' } }, required: ['operation'] },
              then: {
                not: {
                  anyOf: [
                    { required: ['content'] },
                    { required: ['ensure_final_newline'] },
                  ],
                },
              },
            },
          ],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            operation: { type: 'string', enum: ['create', 'update', 'delete'] },
            content: { type: 'string', description: 'Complete UTF-8 text. Required for create/update and forbidden for delete.' },
            ensure_final_newline: {
              type: 'boolean',
              description: 'For create/update, append a final LF only when content does not already end in LF. Use when an upstream text transport cannot preserve terminal newlines.',
            },
          },
        },
      },
      commit_message: { type: 'string', minLength: 1, maxLength: 10000 },
      idempotency_key: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Optional exact retry key. Reuse only for the identical semantic request.',
      },
    },
  },
  async handler(args, ctx) {
    return applyGithubChangesetWithGitHubApp(args, { db: ctx.db });
  },
};