import { storage } from 'hatchable';
import { GitHubContentTransportError, githubContentTransportErrorResult, prepareGithubContentReference } from 'lib/github-content-transport.js';

export const access = 'admin';

export default {
  name: 'github_prepare_changeset_content',
  description: 'Prepare canonical UTF-8 text as an opaque temporary content reference for github_apply_changeset. Overcenter mechanically chooses raw, gzip, or bounded staged storage and owns compression, chunks, ordering, checksums, expiry, and cleanup. Use this only when a content reference is useful across requests; ordinary small changes may pass content directly to github_apply_changeset.',
  inputSchema: {
    type: 'object',
    required: ['content'],
    additionalProperties: false,
    properties: {
      content: {
        type: 'string',
        description: 'Complete canonical UTF-8 text. Do not gzip, base64-encode, split, number, or checksum it yourself.',
      },
    },
  },
  async handler(args) {
    try {
      const prepared = await prepareGithubContentReference(args?.content, { storage });
      return { ok:true, ...prepared };
    } catch (error) {
      if (error instanceof GitHubContentTransportError || error?.code === 'INVALID_CONTENT_TRANSPORT') {
        return githubContentTransportErrorResult(error);
      }
      throw error;
    }
  },
};