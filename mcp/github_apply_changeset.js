import { storage } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { applyGithubChangesetRoleAware } from 'lib/github-branch-role-runtime.js';
import { GitHubContentTransportError, expandGithubContentReferences, githubContentTransportErrorResult } from 'lib/github-content-transport.js';

export const access = 'admin';

export default {
  name: 'github_apply_changeset',
  description: 'Atomically apply a declared multi-file UTF-8 repository changeset as one Git commit under an active Overcenter work lease. Supports create/update/delete, optimistic expected_head checks, non-force branch updates, exact idempotent replay, and managed branch-role enforcement. This MCP tool exposes the conceptual github.apply_changeset command using an underscore-safe transport name.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'branch', 'changes', 'commit_message', 'lease_token'],
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
        description: 'Target work branch to create or fast-forward. Managed development and production branches reject ordinary changesets.',
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
              then: {
                oneOf: [
                  { required: ['content'], not: { anyOf: [{ required: ['content_ref'] }, { required: ['content_gzip_base64'] }] } },
                  { required: ['content_ref'], not: { anyOf: [{ required: ['content'] }, { required: ['content_gzip_base64'] }] } },
                  { required: ['content_gzip_base64'], not: { anyOf: [{ required: ['content'] }, { required: ['content_ref'] }] } },
                ],
              },
            },
            {
              if: { properties: { operation: { const: 'delete' } }, required: ['operation'] },
              then: {
                not: {
                  anyOf: [
                    { required: ['content'] },
                    { required: ['content_ref'] },
                    { required: ['content_gzip_base64'] },
                    { required: ['ensure_final_newline'] },
                  ],
                },
              },
            },
          ],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            operation: { type: 'string', enum: ['create', 'update', 'delete'] },
            content: { type: 'string', description: 'Complete canonical UTF-8 text. Preferred ordinary path. Overcenter owns any transport adaptation below this semantic boundary.' },
            content_ref: { type: 'string', pattern: '^gct1_[A-Za-z0-9-]{8,64}$', description: 'Opaque temporary reference returned by github_prepare_changeset_content. Resolved to canonical UTF-8 before journaling, semantic normalization, and idempotency hashing.' },
            content_gzip_base64: { type: 'string', description: 'Legacy compatibility transport for existing callers. Expanded before semantic normalization and idempotency hashing. New callers should provide content directly or use an opaque content_ref rather than manufacturing gzip/base64.' },
            ensure_final_newline: {
              type: 'boolean',
              description: 'For create/update, append a final LF only when content does not already end in LF. Use when an upstream text transport cannot preserve terminal newlines.',
            },
          },
        },
      },
      commit_message: { type: 'string', minLength: 1, maxLength: 10000 },
      lease_token: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'Opaque token from the active Overcenter work.claim lease that authorizes this repository mutation. Capability material; never persist or log it.',
      },
      idempotency_key: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Optional exact retry key. Reuse only for the identical semantic request.',
      },
      run_id: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        description: 'Optional orchestration run token used only for correlation and excluded from the changeset semantic request hash.',
      },
    },
  },
  async handler(args, ctx) {
    let input;
    try {
      input = await expandGithubContentReferences(args || {}, { storage });
    } catch (error) {
      if (error instanceof GitHubContentTransportError) return githubContentTransportErrorResult(error);
      throw error;
    }
    const response = await executeCorrelatedCommand(
      'github.apply_changeset',
      input,
      (request) => applyGithubChangesetRoleAware(request, { db: ctx.db }),
      { flattenDetails: true, db: ctx.db },
    );
    return response.body;
  },
};