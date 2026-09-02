import { db, storage } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { applyGithubChangesetRoleAware } from 'lib/github-branch-role-runtime.js';
import { createPostgresExecutionAuthorityService } from 'lib/execution-authority.js';
import { GitHubContentTransportError, expandGithubContentReferences, githubContentTransportErrorResult } from 'lib/github-content-transport.js';

export const access = 'admin';
export const methods = ['POST'];

const STAGE_ID = /^[A-Za-z0-9._-]{1,120}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function statusFor(result) {
  if (result.ok) return 200;
  if (result.error === 'GITHUB_APP_SETUP_REQUIRED') return 412;
  if (result.error === 'GITHUB_PERMISSION_DENIED' || result.error === 'GITHUB_APP_PERMISSION_DENIED') return 403;
  if (result.error === 'GITHUB_NOT_FOUND' || result.error === 'GITHUB_APP_INSTALLATION_NOT_FOUND') return 404;
  if (['HEAD_MISMATCH', 'BRANCH_CREATION_RACE', 'TARGET_BRANCH_DISAPPEARED', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS', 'CREATE_TARGET_EXISTS', 'UPDATE_TARGET_MISSING', 'DELETE_TARGET_MISSING', 'GITHUB_CONFLICT', 'EXECUTION_AUTHORITY_REQUIRED', 'EXECUTION_AUTHORITY_INVALID', 'EXECUTION_AUTHORITY_STALE', 'EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'GITHUB_BRANCH_ROLE_VIOLATION'].includes(result.error)) return 409;
  if (result.error === 'EXECUTION_AUTHORITY_UNAVAILABLE') return 503;
  if (result.error === 'GITHUB_REF_REJECTED') return 422;
  if (String(result.error || '').startsWith('INVALID_') || result.error === 'DUPLICATE_PATH' || result.error === 'UNSUPPORTED_BINARY_PAYLOAD' || result.error === 'UNSUPPORTED_TARGET_TYPE' || result.error === 'CONTENT_CHECKSUM_MISMATCH') return 422;
  return 502;
}

async function expandStagedContent(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.changes)) return input;
  const changes = [];
  for (let changeIndex = 0; changeIndex < input.changes.length; changeIndex += 1) {
    const change = input.changes[changeIndex];
    const stage = change?.content_gzip_base64_stage;
    if (stage === undefined) {
      changes.push(change);
      continue;
    }
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw Object.assign(new Error('content_gzip_base64_stage must be an object'), { code: 'INVALID_REQUEST' });
    }
    const stageId = String(stage.stage_id || '');
    const totalChunks = Number(stage.total_chunks);
    const compressedSha256 = String(stage.compressed_sha256 || '').toLowerCase();
    if (!STAGE_ID.test(stageId) || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 256 || !SHA256.test(compressedSha256)) {
      throw Object.assign(new Error('invalid staged content descriptor'), { code: 'INVALID_REQUEST' });
    }
    const chunks = [];
    for (let index = 0; index < totalChunks; index += 1) {
      const key = `github-text-stage/${stageId}/${String(index).padStart(3, '0')}.txt`;
      const stored = await storage.get(key);
      if (!stored?.buffer) {
        throw Object.assign(new Error(`staged content chunk ${index} is missing`), { code: 'INVALID_REQUEST' });
      }
      const chunk = new TextDecoder('utf-8', { fatal: true }).decode(stored.buffer);
      chunks.push(chunk);
    }
    const { content_gzip_base64_stage: ignored, ...rest } = change;
    changes.push({
      ...rest,
      content_gzip_base64_chunks: chunks,
      content_gzip_base64_sha256: compressedSha256,
    });
  }
  return { ...input, changes };
}

async function applyAuthorityAwareChangeset(commandInput, runId = null) {
  if (commandInput?.lease_ref === undefined || commandInput?.lease_ref === null) {
    return applyGithubChangesetRoleAware(commandInput, { db, run_id:runId });
  }

  const { lease_ref: leaseRef, ...changesetInput } = commandInput;
  const authority = createPostgresExecutionAuthorityService({ db });
  const executionAuthority = {
    require(request) {
      return authority.require({ ...request, lease_ref: leaseRef });
    },
  };
  return applyGithubChangesetRoleAware(changesetInput, { db, executionAuthority, run_id:runId });
}

export default async function (req, res) {
  let input;
  try {
    const referenced = await expandGithubContentReferences(req.body || {}, { storage });
    input = await expandStagedContent(referenced);
  } catch (error) {
    if (error instanceof GitHubContentTransportError) {
      return res.status(error.httpStatus || 422).json(githubContentTransportErrorResult(error));
    }
    return res.status(422).json({ ok: false, error: error?.code || 'INVALID_REQUEST', message: String(error?.message || error) });
  }
  const runId = typeof input?.run_id === 'string' ? input.run_id : null;
  const response = await executeCorrelatedCommand(
    'github.apply_changeset',
    input,
    (commandInput) => applyAuthorityAwareChangeset(commandInput, runId),
    { statusForFailure: statusFor, flattenDetails: true, db },
  );
  return res.status(response.status).json(response.body);
}