import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';
import { BRANCH_POLICY_VERSION, WORK_BRANCH_TYPES, isConformingWorkBranch } from 'lib/branch-policy-v1.js';

const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^[A-Za-z0-9._/+\-]+$/;
const OPERATIONS = new Set(['create', 'update', 'delete']);
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const STALE_CLAIM_SECONDS = 30;
const MECHANICAL_CLEANUP_MESSAGE = /^(?:style|format|fmt|lint|chore\((?:format|fmt|lint)\)|fix\((?:format|fmt|lint)\)):/i;

function isMechanicalCleanupMessage(message) {
  return MECHANICAL_CLEANUP_MESSAGE.test(String(message || '').trim());
}

export class GitHubChangesetError extends Error {
  constructor(code, message, details = null, httpStatus = null) {
    super(message);
    this.name = 'GitHubChangesetError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = null) {
  throw new GitHubChangesetError(code, message, details, httpStatus);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REQUEST', `${field} must be an object`, { field }, 422);
  }
  return value;
}

function exactFields(value, allowed, field) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', `${field} contains unknown fields`, { field, unknown }, 422);
}

function requiredString(value, field, max = null) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_REQUEST', `${field} must be a non-empty string`, { field }, 422);
  }
  if (max !== null && value.length > max) {
    fail('INVALID_REQUEST', `${field} exceeds ${max} characters`, { field, max }, 422);
  }
  return value;
}

function validateRepo(value) {
  const repo = requiredString(value, 'repo', 256);
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be owner/repo', { repo }, 422);
  return repo;
}

function validateSha(value, field) {
  const sha = requiredString(value, field, 40).toLowerCase();
  if (!SHA40.test(sha)) fail('INVALID_SHA', `${field} must be a full 40-character hexadecimal Git commit SHA`, { field }, 422);
  return sha;
}

function validateBranch(value) {
  const branch = requiredString(value, 'branch', 255);
  if (!SAFE_BRANCH.test(branch)
      || branch.startsWith('/')
      || branch.endsWith('/')
      || branch.endsWith('.')
      || branch.includes('..')
      || branch.includes('//')
      || branch.includes('@{')
      || branch.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.lock'))) {
    fail('INVALID_BRANCH', 'branch is not a safe Git branch name', { branch }, 422);
  }
  return branch;
}

function validateBaseRef(value) {
  const ref = requiredString(value, 'base_ref', 1024);
  if (ref.includes('\\') || /[\u0000-\u001f\u007f]/.test(ref)) {
    fail('INVALID_BASE_REF', 'base_ref contains invalid characters', { base_ref: ref }, 422);
  }
  return ref;
}

function validatePath(value, index) {
  const field = `changes[${index}].path`;
  const path = requiredString(value, field, 4096);
  const segments = path.split('/');
  if (path.startsWith('/')
      || path.endsWith('/')
      || path.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(path)
      || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail('INVALID_PATH', 'change path must be a clean repository-relative path', { path, index }, 422);
  }
  return path;
}

function validateUnicodeText(value, field) {
  if (typeof value !== 'string') fail('UNSUPPORTED_BINARY_PAYLOAD', `${field} must be complete UTF-8 text`, { field }, 422);
  if (value.includes('\u0000')) fail('UNSUPPORTED_BINARY_PAYLOAD', `${field} contains a NUL byte and is not accepted as text`, { field }, 422);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('INVALID_UTF8_TEXT', `${field} contains an unpaired Unicode surrogate`, { field }, 422);
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('INVALID_UTF8_TEXT', `${field} contains an unpaired Unicode surrogate`, { field }, 422);
    }
  }
  return value;
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function decodeGzipBase64Utf8(value, field) {
  const encoded = requiredString(value, field, 2_000_000);
  let compressed;
  try {
    const binary = atob(encoded);
    compressed = Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    fail('INVALID_REQUEST', `${field} must be valid base64`, { field }, 422);
  }

  const compressedSha256 = await sha256Bytes(compressed);
  let decoded;
  try {
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    await writer.write(compressed);
    await writer.close();
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      total += chunk.length;
      if (total > 2_000_000) {
        fail('INVALID_REQUEST', `${field} expands beyond the 2 MB UTF-8 content limit`, { field }, 422);
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof GitHubChangesetError) throw error;
    fail('INVALID_REQUEST', `${field} must contain gzip-compressed UTF-8 text`, { field, encoded_length: encoded.length, compressed_length: compressed.length, compressed_sha256: compressedSha256 }, 422);
  }
  return validateUnicodeText(decoded, field);
}

async function expandEncodedChangeContent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.changes)) {
    return input;
  }
  const changes = [];
  for (let index = 0; index < input.changes.length; index += 1) {
    const raw = input.changes[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.content_gzip_base64 === undefined) {
      changes.push(raw);
      continue;
    }
    if (raw.content !== undefined) {
      fail('INVALID_OPERATION', 'create/update changes must provide exactly one content transport', { path: raw.path || null, index }, 422);
    }
    const content = await decodeGzipBase64Utf8(raw.content_gzip_base64, `changes[${index}].content_gzip_base64`);
    const { content_gzip_base64: ignored, ...rest } = raw;
    changes.push({ ...rest, content });
  }
  return { ...input, changes };
}

export function normalizeGithubChangesetRequest(input) {
  const body = object(input, 'request');
  exactFields(body, new Set([
    'repo', 'base_ref', 'base_sha', 'branch', 'expected_head', 'changes',
    'commit_message', 'idempotency_key',
  ]), 'request');

  const repo = validateRepo(body.repo);
  const branch = validateBranch(body.branch);
  const hasBaseRef = body.base_ref !== undefined && body.base_ref !== null;
  const hasBaseSha = body.base_sha !== undefined && body.base_sha !== null;
  if (hasBaseRef === hasBaseSha) {
    fail('INVALID_BASE', 'provide exactly one of base_ref or base_sha', null, 422);
  }
  const baseRef = hasBaseRef ? validateBaseRef(body.base_ref) : null;
  const baseSha = hasBaseSha ? validateSha(body.base_sha, 'base_sha') : null;
  const expectedHead = body.expected_head === undefined || body.expected_head === null
    ? null
    : validateSha(body.expected_head, 'expected_head');
  const commitMessage = requiredString(body.commit_message, 'commit_message', 10000);
  const idempotencyKey = body.idempotency_key === undefined || body.idempotency_key === null
    ? null
    : requiredString(body.idempotency_key, 'idempotency_key', 200);

  if (!Array.isArray(body.changes) || body.changes.length === 0) {
    fail('INVALID_CHANGESET', 'changes must be a non-empty array', null, 422);
  }

  const seen = new Set();
  const changes = body.changes.map((raw, index) => {
    const change = object(raw, `changes[${index}]`);
    exactFields(change, new Set(['path', 'operation', 'content', 'ensure_final_newline']), `changes[${index}]`);
    const path = validatePath(change.path, index);
    if (seen.has(path)) fail('DUPLICATE_PATH', 'changeset contains the same path more than once', { path }, 422);
    seen.add(path);
    const operation = requiredString(change.operation, `changes[${index}].operation`, 16);
    if (!OPERATIONS.has(operation)) {
      fail('INVALID_OPERATION', 'operation must be create, update, or delete', { path, operation }, 422);
    }
    const ensureFinalNewline = change.ensure_final_newline === undefined
      ? false
      : change.ensure_final_newline;
    if (typeof ensureFinalNewline !== 'boolean') {
      fail('INVALID_REQUEST', `changes[${index}].ensure_final_newline must be a boolean`, { path, index }, 422);
    }
    if (operation === 'delete') {
      if (change.content !== undefined || change.ensure_final_newline !== undefined) {
        fail('INVALID_OPERATION', 'delete changes must not include content or ensure_final_newline', { path, operation }, 422);
      }
      return { path, operation };
    }
    if (change.content === undefined) {
      fail('INVALID_OPERATION', `${operation} changes require complete text content`, { path, operation }, 422);
    }
    let content = validateUnicodeText(change.content, `changes[${index}].content`);
    if (ensureFinalNewline && !content.endsWith('\n')) content += '\n';
    return {
      path,
      operation,
      content,
      ...(ensureFinalNewline ? { ensure_final_newline: true } : {}),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  return {
    repo,
    base_ref: baseRef,
    base_sha: baseSha,
    branch,
    expected_head: expectedHead,
    changes,
    commit_message: commitMessage,
    idempotency_key: idempotencyKey,
  };
}

async function requestHash(normalized) {
  const { idempotency_key: ignored, ...semantic } = normalized;
  return sha256Text(canonicalJson(semantic));
}

// Authentication/setup failures are normalized by applyGithubChangesetWithGitHubApp.

function upstreamMessage(body) {
  if (body && typeof body === 'object' && body.message) return String(body.message);
  if (typeof body === 'string' && body.trim()) return body.trim();
  return null;
}

function encodePathComponent(value) {
  return encodeURIComponent(String(value));
}

function encodeBranchPath(branch) {
  return branch.split('/').map(encodePathComponent).join('/');
}

export function createGithubApiAdapter(apiClient, options = {}) {
  if (!apiClient || typeof apiClient.call !== 'function') {
    fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub API transport is required.', null, 500);
  }

  async function invoke(method, path, body, query) {
    return apiClient.call('github', {
      method,
      path,
      ...(query ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'Hatchable-Portfolio-Control-Plane/1.0',
      },
    });
  }

  async function call(method, path, {
    body = undefined,
    query = undefined,
    allow404 = false,
    phase = 'github.request',
    retrySafeRead = method === 'GET',
    mayHaveMutated = method !== 'GET',
  } = {}) {
    let response;
    let attempts = 1;
    try {
      if (retrySafeRead) {
        const retried = await boundedSafeRead(
          () => invoke(method, path, body, query),
          { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
        );
        response = retried.response;
        attempts = retried.attempts;
      } else {
        response = await invoke(method, path, body, query);
      }
    } catch (error) {
      const finalAttempts = Number(error?.githubTransportAttempts || attempts || 1);
      fail('GITHUB_TRANSPORT_ERROR', String(error?.message || 'GitHub transport failed'), {
        phase,
        github_path: path,
        status: Number(error?.status || 0) || null,
        github_message: String(error?.message || 'GitHub transport failed'),
        documentation_url: null,
        github_request_id: error?.githubRequestId || null,
        retry_after: error?.retryAfter || null,
        attempts: finalAttempts,
        may_have_mutated: Boolean(mayHaveMutated),
      }, 502);
    }

    const status = Number(response?.status || 0);
    if (status >= 200 && status < 300) return response.body;
    if (allow404 && status === 404) return null;

    const message = upstreamMessage(response?.body) || `GitHub API returned HTTP ${status || 'unknown'}`;
    const evidence = githubTransportEvidence(response, { phase, path, attempts, mayHaveMutated });
    const details = {
      ...evidence,
      github_message: message,
      documentation_url: response?.body?.documentation_url || null,
    };
    if (status === 401 || status === 403) {
      fail('GITHUB_PERMISSION_DENIED', message, details, status);
    }
    if (status === 404) fail('GITHUB_NOT_FOUND', message, details, 404);
    if (status === 409) fail('GITHUB_CONFLICT', message, details, 409);
    if (status === 422) fail('GITHUB_REF_REJECTED', message, details, 422);
    fail('GITHUB_UPSTREAM_ERROR', message, details, status || 502);
  }

  function repoPath(repo) {
    const [owner, name] = repo.split('/');
    return `/repos/${encodePathComponent(owner)}/${encodePathComponent(name)}`;
  }

  async function resolveCommit(repo, selector) {
    const base = repoPath(repo);
    const body = await call('GET', `${base}/commits/${encodePathComponent(selector)}`, { phase: 'preflight.resolve_base' });
    const sha = String(body?.sha || '').toLowerCase();
    const treeSha = String(body?.commit?.tree?.sha || '').toLowerCase();
    if (!SHA40.test(sha) || !SHA40.test(treeSha)) {
      fail('GITHUB_INVALID_RESPONSE', 'GitHub commit response did not contain a full commit and tree SHA', { phase: 'preflight.resolve_base', may_have_mutated: false }, 502);
    }
    return { sha, tree_sha: treeSha };
  }

  async function getBranch(repo, branch, readOptions = {}) {
    const phase = readOptions.phase || 'preflight.branch_read';
    const body = await call('GET', `${repoPath(repo)}/git/ref/heads/${encodeBranchPath(branch)}`, { allow404: true, phase });
    if (!body) return null;
    const sha = String(body?.object?.sha || '').toLowerCase();
    if (!SHA40.test(sha)) fail('GITHUB_INVALID_RESPONSE', 'GitHub branch response did not contain a full commit SHA', { branch, phase, may_have_mutated: false }, 502);
    return { sha };
  }

  async function getCommit(repo, sha) {
    const body = await call('GET', `${repoPath(repo)}/git/commits/${encodePathComponent(sha)}`, { phase: 'preflight.parent_commit' });
    const commitSha = String(body?.sha || '').toLowerCase();
    const treeSha = String(body?.tree?.sha || '').toLowerCase();
    if (!SHA40.test(commitSha) || !SHA40.test(treeSha)) {
      fail('GITHUB_INVALID_RESPONSE', 'GitHub Git commit response was incomplete', { sha, phase: 'preflight.parent_commit', may_have_mutated: false }, 502);
    }
    return {
      sha: commitSha,
      tree_sha: treeSha,
      message: String(body?.message || ''),
      parents: Array.isArray(body?.parents) ? body.parents.map(parent => String(parent?.sha || '').toLowerCase()) : [],
    };
  }

  async function getPathEntries(repo, treeSha, paths) {
    const base = repoPath(repo);
    const recursive = await call('GET', `${base}/git/trees/${encodePathComponent(treeSha)}`, {
      query: { recursive: '1' },
      phase: 'preflight.tree_read',
    });
    const map = new Map();
    for (const entry of recursive?.tree || []) map.set(entry.path, entry);
    if (recursive?.truncated !== true) {
      return new Map(paths.map(path => [path, map.get(path) || null]));
    }

    const treeCache = new Map();
    async function treeEntries(sha) {
      if (!treeCache.has(sha)) {
        const body = await call('GET', `${base}/git/trees/${encodePathComponent(sha)}`, { phase: 'preflight.tree_read' });
        treeCache.set(sha, body?.tree || []);
      }
      return treeCache.get(sha);
    }
    async function findPath(path) {
      let currentTree = treeSha;
      const parts = path.split('/');
      for (let index = 0; index < parts.length; index += 1) {
        const entries = await treeEntries(currentTree);
        const entry = entries.find(item => item.path === parts[index]) || null;
        if (!entry) return null;
        if (index === parts.length - 1) return { ...entry, path };
        if (entry.type !== 'tree') return null;
        currentTree = entry.sha;
      }
      return null;
    }
    const resolved = new Map();
    for (const path of paths) resolved.set(path, await findPath(path));
    return resolved;
  }

  async function createTree(repo, baseTreeSha, entries) {
    const body = await call('POST', `${repoPath(repo)}/git/trees`, {
      body: { base_tree: baseTreeSha, tree: entries },
      phase: 'mutation.tree',
      retrySafeRead: false,
      mayHaveMutated: true,
    });
    const sha = String(body?.sha || '').toLowerCase();
    if (!SHA40.test(sha)) fail('GITHUB_INVALID_RESPONSE', 'GitHub tree creation returned an invalid SHA', { phase: 'mutation.tree', may_have_mutated: true }, 502);
    return sha;
  }

  async function createCommit(repo, { message, treeSha, parentSha }) {
    const body = await call('POST', `${repoPath(repo)}/git/commits`, {
      body: { message, tree: treeSha, parents: [parentSha] },
      phase: 'mutation.commit',
      retrySafeRead: false,
      mayHaveMutated: true,
    });
    const sha = String(body?.sha || '').toLowerCase();
    if (!SHA40.test(sha)) fail('GITHUB_INVALID_RESPONSE', 'GitHub commit creation returned an invalid SHA', { phase: 'mutation.commit', may_have_mutated: true }, 502);
    return sha;
  }

  async function createBranch(repo, branch, sha) {
    await call('POST', `${repoPath(repo)}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha },
      phase: 'mutation.ref_update',
      retrySafeRead: false,
      mayHaveMutated: true,
    });
  }

  async function updateBranch(repo, branch, sha) {
    await call('PATCH', `${repoPath(repo)}/git/refs/heads/${encodeBranchPath(branch)}`, {
      body: { sha, force: false },
      phase: 'mutation.ref_update',
      retrySafeRead: false,
      mayHaveMutated: true,
    });
  }

  return { resolveCommit, getBranch, getCommit, getPathEntries, createTree, createCommit, createBranch, updateBranch };
}

function parseJson(value) {
  if (value === null || value === undefined || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function createGithubChangesetReceiptStore(db) {
  return {
    async claim(normalized, digest, attemptToken) {
      const inserted = await db.query(
        `INSERT INTO github_changeset_receipts (
           repo, idempotency_key, request_sha256, request_json, state,
           attempt_token, branch
         ) VALUES ($1, $2, $3, $4::jsonb, 'processing', $5::uuid, $6)
         ON CONFLICT (repo, idempotency_key) DO NOTHING
         RETURNING *`,
        [normalized.repo, normalized.idempotency_key, digest, canonicalJson(normalized), attemptToken, normalized.branch],
      );
      if (inserted.rows[0]) return { kind: 'claimed', row: inserted.rows[0] };

      let row = (await db.query(
        `SELECT * FROM github_changeset_receipts WHERE repo = $1 AND idempotency_key = $2 LIMIT 1`,
        [normalized.repo, normalized.idempotency_key],
      )).rows[0];
      if (!row) fail('IDEMPOTENCY_CONFLICT', 'idempotency receipt disappeared during claim', null, 409);
      if (row.request_sha256 !== digest) return { kind: 'conflict', row };
      if (row.state === 'succeeded' || row.state === 'prepared') return { kind: 'existing', row };

      const takeover = await db.query(
        `UPDATE github_changeset_receipts
            SET attempt_token = $3::uuid, updated_at = now()
          WHERE repo = $1 AND idempotency_key = $2
            AND state = 'processing'
            AND updated_at < now() - interval '${STALE_CLAIM_SECONDS} seconds'
         RETURNING *`,
        [normalized.repo, normalized.idempotency_key, attemptToken],
      );
      if (takeover.rows[0]) return { kind: 'claimed', row: takeover.rows[0] };
      row = (await db.query(
        `SELECT * FROM github_changeset_receipts WHERE repo = $1 AND idempotency_key = $2 LIMIT 1`,
        [normalized.repo, normalized.idempotency_key],
      )).rows[0];
      if (row?.state === 'succeeded' || row?.state === 'prepared') return { kind: 'existing', row };
      return { kind: 'in_progress', row };
    },

    async savePlan(normalized, attemptToken, plan) {
      await db.query(
        `UPDATE github_changeset_receipts
            SET base_sha = $4, old_head = $5, created_branch = $6,
                precondition_verified = $7, changed_paths = $8::jsonb, updated_at = now()
          WHERE repo = $1 AND idempotency_key = $2 AND attempt_token = $3::uuid`,
        [normalized.repo, normalized.idempotency_key, attemptToken, plan.baseSha, plan.oldHead,
          plan.createdBranch, plan.preconditionVerified, canonicalJson(plan.changedPaths)],
      );
    },

    async heartbeat(normalized, attemptToken, phase) {
      await db.query(
        `UPDATE github_changeset_receipts
            SET updated_at = now()
          WHERE repo = $1 AND idempotency_key = $2
            AND attempt_token = $3::uuid AND state = 'processing'`,
        [normalized.repo, normalized.idempotency_key, attemptToken],
      );
    },

    async saveTree(normalized, attemptToken, treeSha) {
      await db.query(
        `UPDATE github_changeset_receipts
            SET tree_sha = $4, updated_at = now()
          WHERE repo = $1 AND idempotency_key = $2 AND attempt_token = $3::uuid`,
        [normalized.repo, normalized.idempotency_key, attemptToken, treeSha],
      );
    },

    async saveCommit(normalized, attemptToken, commitSha) {
      await db.query(
        `UPDATE github_changeset_receipts
            SET commit_sha = $4, state = 'prepared', updated_at = now()
          WHERE repo = $1 AND idempotency_key = $2 AND attempt_token = $3::uuid`,
        [normalized.repo, normalized.idempotency_key, attemptToken, commitSha],
      );
    },

    async succeed(normalized, receipt) {
      await db.query(
        `UPDATE github_changeset_receipts
            SET state = 'succeeded', receipt = $3::jsonb, updated_at = now()
          WHERE repo = $1 AND idempotency_key = $2`,
        [normalized.repo, normalized.idempotency_key, canonicalJson(receipt)],
      );
    },

    async abandon(normalized, attemptToken) {
      await db.query(
        `DELETE FROM github_changeset_receipts
          WHERE repo = $1 AND idempotency_key = $2
            AND attempt_token = $3::uuid AND state = 'processing' AND commit_sha IS NULL`,
        [normalized.repo, normalized.idempotency_key, attemptToken],
      );
    },
  };
}

function receiptFromPlan(normalized, plan, commitSha, treeSha, idempotentReplay) {
  return {
    ok: true,
    repo: normalized.repo,
    branch: normalized.branch,
    base_sha: plan.baseSha,
    old_head: plan.oldHead,
    new_head: commitSha,
    commit_sha: commitSha,
    tree_sha: treeSha,
    created_branch: plan.createdBranch,
    precondition_verified: plan.preconditionVerified,
    changed_paths: plan.changedPaths,
    ...(normalized.idempotency_key ? { idempotency_key: normalized.idempotency_key } : {}),
    idempotent_replay: idempotentReplay,
  };
}

function planFromRow(row) {
  return {
    baseSha: row.base_sha,
    oldHead: row.old_head || null,
    createdBranch: Boolean(row.created_branch),
    preconditionVerified: Boolean(row.precondition_verified),
    changedPaths: parseJson(row.changed_paths) || [],
  };
}

function errorResult(error) {
  if (!(error instanceof GitHubChangesetError)) throw error;
  return {
    ok: false,
    error: error.code,
    message: error.message,
    ...(error.details && typeof error.details === 'object' ? error.details : {}),
  };
}

async function finalizePrepared({ normalized, github, receipts, plan, commitSha, treeSha, replay }) {
  const current = await github.getBranch(normalized.repo, normalized.branch, { phase: 'finalize.branch_read' });
  if (current?.sha === commitSha) {
    const recovered = receiptFromPlan(normalized, plan, commitSha, treeSha, true);
    if (receipts && normalized.idempotency_key) await receipts.succeed(normalized, recovered);
    return recovered;
  }

  if (plan.createdBranch) {
    if (current) {
      fail('BRANCH_CREATION_RACE', 'target branch appeared after the changeset was prepared', {
        expected_head: null,
        actual_head: current.sha,
        branch: normalized.branch,
        phase: 'finalize',
      }, 409);
    }
  } else {
    if (!current) {
      fail('TARGET_BRANCH_DISAPPEARED', 'target branch disappeared before the ref update', {
        expected_head: plan.oldHead,
        actual_head: null,
        branch: normalized.branch,
        phase: 'finalize',
      }, 409);
    }
    if (current.sha !== plan.oldHead) {
      fail('HEAD_MISMATCH', 'target branch head changed before the ref update', {
        expected_head: plan.oldHead,
        actual_head: current.sha,
        branch: normalized.branch,
        phase: 'finalize',
      }, 409);
    }
  }

  try {
    if (plan.createdBranch) await github.createBranch(normalized.repo, normalized.branch, commitSha);
    else await github.updateBranch(normalized.repo, normalized.branch, commitSha);
  } catch (error) {
    if (!(error instanceof GitHubChangesetError)) throw error;
    const after = await github.getBranch(normalized.repo, normalized.branch, { phase: 'reconcile.ref_readback' });
    if (after?.sha === commitSha) {
      const recovered = receiptFromPlan(normalized, plan, commitSha, treeSha, true);
      if (receipts && normalized.idempotency_key) await receipts.succeed(normalized, recovered);
      return recovered;
    }
    if (plan.createdBranch && after) {
      fail('BRANCH_CREATION_RACE', 'target branch was created concurrently', {
        expected_head: null,
        actual_head: after.sha,
        branch: normalized.branch,
        phase: 'ref_update',
      }, 409);
    }
    if (!plan.createdBranch && after && after.sha !== plan.oldHead) {
      fail('HEAD_MISMATCH', 'target branch head changed concurrently', {
        expected_head: plan.oldHead,
        actual_head: after.sha,
        branch: normalized.branch,
        phase: 'ref_update',
      }, 409);
    }
    throw error;
  }

  const receipt = receiptFromPlan(normalized, plan, commitSha, treeSha, replay);
  if (receipts && normalized.idempotency_key) await receipts.succeed(normalized, receipt);
  return receipt;
}

function validateExistingTargets(changes, entries) {
  for (const change of changes) {
    const entry = entries.get(change.path) || null;
    if (change.operation === 'create' && entry) {
      fail('CREATE_TARGET_EXISTS', 'create target already exists in the parent tree', { path: change.path }, 409);
    }
    if (change.operation === 'update' && !entry) {
      fail('UPDATE_TARGET_MISSING', 'update target does not exist in the parent tree', { path: change.path }, 409);
    }
    if (change.operation === 'delete' && !entry) {
      fail('DELETE_TARGET_MISSING', 'delete target does not exist in the parent tree', { path: change.path }, 409);
    }
    if (entry && (change.operation === 'update' || change.operation === 'delete')) {
      if (entry.type !== 'blob' || !REGULAR_FILE_MODES.has(String(entry.mode))) {
        fail('UNSUPPORTED_TARGET_TYPE', 'update/delete currently supports regular repository files only', {
          path: change.path,
          type: entry.type || null,
          mode: entry.mode || null,
        }, 422);
      }
    }
  }
}

export async function applyGithubChangeset(input, options = {}) {
  let normalized;
  let receipts = options.receipts || null;
  let attemptToken = null;
  let prepared = false;
  try {
    normalized = normalizeGithubChangesetRequest(await expandEncodedChangeContent(input));
    const github = options.github || createGithubApiAdapter(options.apiClient);
    if (!receipts && normalized.idempotency_key) {
      if (!options.db) fail('IDEMPOTENCY_UNAVAILABLE', 'idempotency_key requires a receipt store', null, 500);
      receipts = createGithubChangesetReceiptStore(options.db);
    }

    const digest = await requestHash(normalized);
    if (normalized.idempotency_key) {
      attemptToken = (options.idFactory || (() => crypto.randomUUID()))();
      const claim = await receipts.claim(normalized, digest, attemptToken);
      if (claim.kind === 'conflict') {
        return {
          ok: false,
          error: 'IDEMPOTENCY_CONFLICT',
          message: 'idempotency_key was already used for a different changeset request',
          repo: normalized.repo,
          idempotency_key: normalized.idempotency_key,
        };
      }
      if (claim.kind === 'in_progress') {
        return {
          ok: false,
          error: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'an identical request with this idempotency_key is still in progress',
          repo: normalized.repo,
          idempotency_key: normalized.idempotency_key,
        };
      }
      if (claim.kind === 'existing' && claim.row.state === 'succeeded') {
        const stored = parseJson(claim.row.receipt);
        return { ...stored, idempotent_replay: true };
      }
      if (claim.kind === 'existing' && claim.row.state === 'prepared') {
        prepared = true;
        const plan = planFromRow(claim.row);
        return await finalizePrepared({
          normalized,
          github,
          receipts,
          plan,
          commitSha: claim.row.commit_sha,
          treeSha: claim.row.tree_sha,
          replay: true,
        });
      }
    }

    const selector = normalized.base_sha || normalized.base_ref;
    const requestedBase = await github.resolveCommit(normalized.repo, selector);
    const branch = await github.getBranch(normalized.repo, normalized.branch);
    if (!branch && !isConformingWorkBranch(normalized.branch)) {
      fail('INVALID_BRANCH_POLICY', 'New work branch name does not satisfy branch-policy-v1.', {
        branch: normalized.branch,
        policy_version: BRANCH_POLICY_VERSION,
        allowed_types: [...WORK_BRANCH_TYPES],
        expected_shape: '<type>/<kebab-description>',
        legacy_existing_branches_are_grandfathered: true,
      }, 422);
    }
    const parentSha = branch?.sha || requestedBase.sha;
    if (normalized.expected_head && normalized.expected_head !== parentSha) {
      fail('HEAD_MISMATCH', 'expected_head does not match the commit the changeset would build on', {
        expected_head: normalized.expected_head,
        actual_head: parentSha,
        branch: normalized.branch,
        phase: 'preflight',
      }, 409);
    }

    const parent = parentSha === requestedBase.sha
      ? requestedBase
      : await github.getCommit(normalized.repo, parentSha);
    if (branch
        && isMechanicalCleanupMessage(normalized.commit_message)
        && isMechanicalCleanupMessage(parent.message)) {
      fail('MECHANICAL_CHANGESET_MUST_COALESCE', 'Consecutive mechanical cleanup changesets must be coalesced into one repair commit.', {
        branch: normalized.branch,
        parent_head: parentSha,
        parent_message: parent.message,
        commit_message: normalized.commit_message,
        phase: 'preflight',
      }, 409);
    }
    const changedPaths = normalized.changes.map(change => ({ path: change.path, operation: change.operation }));
    const plan = {
      baseSha: parentSha,
      oldHead: branch?.sha || null,
      createdBranch: !branch,
      preconditionVerified: Boolean(normalized.expected_head),
      changedPaths,
    };
    if (receipts && normalized.idempotency_key) await receipts.savePlan(normalized, attemptToken, plan);

    const paths = normalized.changes.map(change => change.path);
    const existing = await github.getPathEntries(normalized.repo, parent.tree_sha, paths);
    validateExistingTargets(normalized.changes, existing);
    if (receipts && normalized.idempotency_key) {
      await receipts.heartbeat(normalized, attemptToken, 'preflight_complete');
    }

    const treeEntries = [];
    for (const change of normalized.changes) {
      const current = existing.get(change.path) || null;
      if (change.operation === 'delete') {
        treeEntries.push({ path: change.path, mode: current.mode, type: 'blob', sha: null });
        continue;
      }
      treeEntries.push({
        path: change.path,
        mode: current?.mode || '100644',
        type: 'blob',
        content: change.content,
      });
    }

    const treeSha = await github.createTree(normalized.repo, parent.tree_sha, treeEntries);
    if (receipts && normalized.idempotency_key) await receipts.saveTree(normalized, attemptToken, treeSha);
    const commitSha = await github.createCommit(normalized.repo, {
      message: normalized.commit_message,
      treeSha,
      parentSha,
    });
    if (receipts && normalized.idempotency_key) {
      await receipts.saveCommit(normalized, attemptToken, commitSha);
      prepared = true;
    }

    return await finalizePrepared({ normalized, github, receipts, plan, commitSha, treeSha, replay: false });
  } catch (error) {
    if (normalized?.idempotency_key && receipts && attemptToken && !prepared) {
      try { await receipts.abandon(normalized, attemptToken); } catch { /* preserve original error */ }
    }
    return errorResult(error);
  }
}

export async function applyGithubChangesetWithGitHubApp(input, options = {}) {
  try {
    return await withGitHubAppApiClient(input?.repo, async (apiClient) => {
      return applyGithubChangeset(input, { ...options, apiClient });
    }, { permissionProfile: 'changeset' });
  } catch (error) {
    const message = String(error?.message || 'GitHub App authentication failed.');
    const transportEvidence = {
      ...(error?.phase ? { phase: error.phase } : {}),
      ...(error?.githubPath ? { github_path: error.githubPath } : {}),
      ...(error?.githubRequestId ? { github_request_id: error.githubRequestId } : {}),
      ...(error?.retryAfter ? { retry_after: error.retryAfter } : {}),
      ...(error?.attempts ? { attempts: Number(error.attempts) } : {}),
      ...(error?.mayHaveMutated !== undefined ? { may_have_mutated: Boolean(error.mayHaveMutated) } : {}),
    };
    const setupRequired = /config\/get 412|declared as required but not set/i.test(message);
    if (setupRequired) {
      return {
        ok: false,
        error: 'GITHUB_APP_SETUP_REQUIRED',
        message: 'Configure the GitHub App ID and private key in Hatchable Setup before using this command.'
      };
    }
    if (error?.code === 'INVALID_REPO' || error?.code === 'INVALID_GITHUB_APP_ID' || error?.code === 'INVALID_GITHUB_APP_PRIVATE_KEY') {
      return { ok: false, error: error.code, message };
    }
    if (Number(error?.status) === 404) {
      return {
        ok: false,
        error: 'GITHUB_APP_INSTALLATION_NOT_FOUND',
        message: 'The GitHub App is not installed for this repository.',
        upstream_status: 404,
        ...transportEvidence,
      };
    }
    if (Number(error?.status) === 401 || Number(error?.status) === 403) {
      return {
        ok: false,
        error: 'GITHUB_APP_PERMISSION_DENIED',
        message,
        upstream_status: Number(error.status),
        ...transportEvidence,
      };
    }
    return {
      ok: false,
      error: error?.code || 'GITHUB_APP_AUTH_ERROR',
      message,
      ...(error?.status ? { upstream_status: Number(error.status) } : {}),
      ...transportEvidence,
    };
  }
}