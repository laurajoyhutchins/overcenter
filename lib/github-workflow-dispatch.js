// GitHub App transport is injected by the runtime host.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9._/+\-]+$/;
const WORKFLOW = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const SHA40 = /^[0-9a-f]{40}$/;
const INPUT_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_INPUTS = 10;
const MAX_INPUT_VALUE = 4096;
const MAX_CONFIRM_ATTEMPTS = 8;
const CONFIRM_DELAY_MS = 250;
const CREATION_SKEW_MS = 5000;

function failure(code, message, details = {}, options = {}) {
  return Object.assign(new Error(message), {
    code,
    httpStatus: options.httpStatus ?? 422,
    may_have_mutated: options.mayHaveMutated === true,
    details,
  });
}

function githubFailure(response, operation, options = {}) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const code = status === 401 || status === 403
    ? 'GITHUB_APP_PERMISSION_DENIED'
    : status === 404
      ? 'GITHUB_NOT_FOUND'
      : 'GITHUB_UPSTREAM_ERROR';
  throw failure(code, message, { operation, upstream_status: status || null }, {
    httpStatus: status >= 400 && status < 600 ? status : 502,
    mayHaveMutated: options.mayHaveMutated,
  });
}

function normalizeInputs(input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw failure('INVALID_INPUTS', 'inputs must be an object of bounded string values');
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_INPUTS) throw failure('INVALID_INPUTS', `inputs may contain at most ${MAX_INPUTS} values`);
  const normalized = {};
  for (const [key, value] of entries) {
    if (!INPUT_KEY.test(key)) throw failure('INVALID_INPUTS', 'input keys must be safe workflow input identifiers', { key });
    if (typeof value !== 'string' || value.length > MAX_INPUT_VALUE) {
      throw failure('INVALID_INPUTS', `workflow input ${key} must be a bounded string`, { key });
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeRequest(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = new Set(['repo', 'workflow', 'ref', 'expected_head', 'inputs']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw failure('INVALID_REQUEST', 'request contains unknown fields', { fields: unknown.sort() });

  const repo = String(body.repo || '').trim();
  if (!REPO.test(repo)) throw failure('INVALID_REPOSITORY', 'repo must be in owner/name form');

  const workflow = String(body.workflow || '').trim();
  if (!WORKFLOW.test(workflow)) throw failure('INVALID_WORKFLOW', 'workflow must be a workflow YAML filename');

  const ref = String(body.ref || '').trim();
  if (!REF.test(ref) || ref.startsWith('/') || ref.endsWith('/') || ref.includes('..') || ref.includes('//')) {
    throw failure('INVALID_REF', 'ref must be a safe Git branch name');
  }

  const expectedHead = String(body.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedHead)) throw failure('INVALID_EXPECTED_HEAD', 'expected_head must be an exact 40-character Git SHA');

  return { repo, workflow, ref, expected_head: expectedHead, inputs: normalizeInputs(body.inputs) };
}

function runCarriesRequestId(run, requestId) {
  if (!requestId) return true;
  const title = String(run?.display_title || run?.name || '');
  return title.includes(requestId);
}

function recentMatchingRun(runs, expectedHead, dispatchStartedAt, requestId = '') {
  const lowerBound = dispatchStartedAt - CREATION_SKEW_MS;
  return (Array.isArray(runs) ? runs : []).find((run) => {
    if (String(run?.head_sha || '').toLowerCase() !== expectedHead) return false;
    if (run?.event !== 'workflow_dispatch') return false;
    if (!runCarriesRequestId(run, requestId)) return false;
    const created = Date.parse(String(run?.created_at || ''));
    return Number.isFinite(created) && created >= lowerBound;
  }) || null;
}

const MAX_TERMINAL_ATTEMPTS = 120;
const TERMINAL_DELAY_MS = 500;
const MAX_RECEIPT_ARCHIVE_BYTES = 2 * 1024 * 1024;
const RECEIPT_FILE = 'bounded-semantic-response.json';

function extractZipEntry(base64Archive, expectedName) {
  const zip = Buffer.from(String(base64Archive || ''), 'base64');
  if (!zip.length || zip.length > MAX_RECEIPT_ARCHIVE_BYTES) {
    throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt archive is missing or oversized', {}, { httpStatus:502, mayHaveMutated:true });
  }
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt archive has no end directory', {}, { httpStatus:502, mayHaveMutated:true });
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  let match = null;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt archive directory is malformed', {}, { httpStatus:502, mayHaveMutated:true });
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === expectedName) {
      if (match) throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt archive contains duplicate receipt files', {}, { httpStatus:502, mayHaveMutated:true });
      match = { method, compressedSize, uncompressedSize, localOffset };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!match) throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt archive does not contain the expected receipt', {}, { httpStatus:502, mayHaveMutated:true });
  const local = match.localOffset;
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt local header is malformed', {}, { httpStatus:502, mayHaveMutated:true });
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const end = start + match.compressedSize;
  if (end > zip.length || match.uncompressedSize > MAX_RECEIPT_ARCHIVE_BYTES) throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt archive bounds are invalid', {}, { httpStatus:502, mayHaveMutated:true });
  const compressed = zip.subarray(start, end);
  const content = match.method === 0 ? compressed : match.method === 8 ? inflateRawSync(compressed, { maxOutputLength:MAX_RECEIPT_ARCHIVE_BYTES }) : null;
  if (!content || content.length !== match.uncompressedSize) throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt compression is unsupported or inconsistent', {}, { httpStatus:502, mayHaveMutated:true });
  return content;
}

export async function readGitHubWorkflowSemanticReceipt(input, options = {}) {
  const repo = String(input?.repo || '').trim();
  const runId = Number(input?.workflow_run_id || 0);
  const requestId = String(input?.request_id || '').trim();
  const command = String(input?.command || '').trim();
  const expectedHead = String(input?.expected_head || '').trim().toLowerCase();
  if (!REPO.test(repo) || !Number.isInteger(runId) || runId <= 0 || !requestId || !command || !SHA40.test(expectedHead)) throw failure('INVALID_RECEIPT_REQUEST', 'terminal semantic receipt request is incomplete');
  const withApp = options.withGitHubAppApiClient;
  if (typeof withApp !== 'function') throw failure('GITHUB_WORKFLOW_RECEIPT_RUNTIME_UNAVAILABLE', 'withGitHubAppApiClient dependency is required', {}, { httpStatus:500, mayHaveMutated:true });
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const [owner, name] = repo.split('/');
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return withApp(repo, async (apiClient) => {
    let run = null;
    for (let attempt = 0; attempt < MAX_TERMINAL_ATTEMPTS; attempt += 1) {
      const observed = await apiClient.call('github', { path:`${root}/actions/runs/${runId}`, method:'GET' });
      if (observed.status !== 200) githubFailure(observed, 'workflow_receipt.run', { mayHaveMutated:true });
      if (String(observed.body?.head_sha || '').toLowerCase() !== expectedHead) throw failure('GITHUB_WORKFLOW_RECEIPT_IDENTITY_MISMATCH', 'semantic run head does not match expected_head', { workflow_run_id:runId }, { httpStatus:409, mayHaveMutated:true });
      if (observed.body?.status === 'completed') { run = observed.body; break; }
      if (attempt < MAX_TERMINAL_ATTEMPTS - 1) await sleep(TERMINAL_DELAY_MS);
    }
    if (!run) throw failure('GITHUB_WORKFLOW_RECEIPT_TERMINAL_UNCONFIRMED', 'semantic workflow did not reach a terminal state in the bounded wait', { workflow_run_id:runId }, { httpStatus:409, mayHaveMutated:true });
    const artifactsResponse = await apiClient.call('github', { path:`${root}/actions/runs/${runId}/artifacts`, method:'GET', query:{ per_page:100 } });
    if (artifactsResponse.status !== 200) githubFailure(artifactsResponse, 'workflow_receipt.artifacts', { mayHaveMutated:true });
    const artifactName = `semantic-response-${requestId}`;
    const matches = (artifactsResponse.body?.artifacts || []).filter((artifact) => artifact?.name === artifactName && artifact?.expired !== true);
    if (matches.length !== 1) throw failure('GITHUB_WORKFLOW_RECEIPT_AMBIGUOUS', 'expected exactly one retained semantic response artifact', { workflow_run_id:runId, artifact_name:artifactName, observed:matches.length }, { httpStatus:409, mayHaveMutated:true });
    const artifact = matches[0];
    const download = await apiClient.call('github', { path:`${root}/actions/artifacts/${artifact.id}/zip`, method:'GET', responseEncoding:'base64' });
    if (download.status !== 200) githubFailure(download, 'workflow_receipt.download', { mayHaveMutated:true });
    let receipt;
    try { receipt = JSON.parse(extractZipEntry(download.body, RECEIPT_FILE).toString('utf8')); }
    catch (error) { if (error?.code) throw error; throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', `semantic receipt is not valid JSON: ${String(error?.message || error)}`, {}, { httpStatus:502, mayHaveMutated:true }); }
    if (receipt?.request_id !== requestId || receipt?.command !== command || String(receipt?.expected_head || '').toLowerCase() !== expectedHead) throw failure('GITHUB_WORKFLOW_RECEIPT_IDENTITY_MISMATCH', 'semantic receipt identity does not match the invocation', { workflow_run_id:runId }, { httpStatus:409, mayHaveMutated:true });
    const responseB64 = String(receipt?.response_b64 || '');
    const claimedDigest = String(receipt?.response_sha256 || '').toLowerCase();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(responseB64) || !/^[0-9a-f]{64}$/.test(claimedDigest)) throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'semantic receipt is missing exact response evidence', {}, { httpStatus:502, mayHaveMutated:true });
    const responseBytes = Buffer.from(responseB64, 'base64');
    const digest = createHash('sha256').update(responseBytes).digest('hex');
    if (digest !== claimedDigest) throw failure('GITHUB_WORKFLOW_RECEIPT_DIGEST_MISMATCH', 'semantic response digest does not match retained bytes', { expected:claimedDigest, observed:digest }, { httpStatus:409, mayHaveMutated:true });
    let response;
    try { response = JSON.parse(responseBytes.toString('utf8')); }
    catch { throw failure('GITHUB_WORKFLOW_RECEIPT_INVALID', 'retained semantic response bytes are not valid JSON', {}, { httpStatus:502, mayHaveMutated:true }); }
    if (JSON.stringify(receipt.response) !== JSON.stringify(response)) throw failure('GITHUB_WORKFLOW_RECEIPT_RESPONSE_MISMATCH', 'parsed semantic response does not match retained response bytes', {}, { httpStatus:409, mayHaveMutated:true });
    return {
      outcome:'completed',
      response,
      receipt:{ schema:'gcp-semantic-receipt-v1', request_id:requestId, command, expected_head:expectedHead, workflow_run_id:runId, workflow_run_conclusion:run.conclusion || null, artifact_id:Number(artifact.id), artifact_name:artifactName, response_sha256:claimedDigest },
      mutation_certainty:'confirmed',
      may_have_mutated:true,
    };
  }, { permissionProfile:'workflow_dispatch' });
}

export async function dispatchGitHubWorkflowWithGitHubApp(input, options = {}) {
  const request = normalizeRequest(input);
  const withApp = options.withGitHubAppApiClient;
  if (typeof withApp !== 'function') {
    throw failure('GITHUB_WORKFLOW_DISPATCH_RUNTIME_UNAVAILABLE', 'withGitHubAppApiClient dependency is required', {}, { httpStatus: 500, mayHaveMutated: false });
  }
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const [owner, name] = request.repo.split('/');
  const repoRoot = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const workflowPath = `${repoRoot}/actions/workflows/${encodeURIComponent(request.workflow)}`;
  const requestId = String(request.inputs.request_id || '');

  return withApp(request.repo, async (apiClient) => {
    const preflight = await apiClient.call('github', {
      path: `${repoRoot}/git/ref/heads/${encodeURIComponent(request.ref)}`,
      method: 'GET',
    });
    if (preflight.status !== 200) githubFailure(preflight, 'workflow_dispatch.preflight');
    const observedHead = String(preflight.body?.object?.sha || '').toLowerCase();
    if (observedHead !== request.expected_head) {
      throw failure(
        'GITHUB_WORKFLOW_DISPATCH_HEAD_MISMATCH',
        'workflow dispatch branch head does not match expected_head',
        { ref: request.ref, expected_head: request.expected_head, observed_head: observedHead || null },
        { httpStatus: 409, mayHaveMutated: false },
      );
    }

    const dispatchStartedAt = Date.now();
    let dispatch;
    try {
      dispatch = await apiClient.call('github', {
        path: `${workflowPath}/dispatches`,
        method: 'POST',
        body: { ref: request.ref, inputs: request.inputs },
      });
    } catch (error) {
      throw failure(
        'GITHUB_WORKFLOW_DISPATCH_INDETERMINATE',
        `workflow dispatch transport failed: ${String(error?.message || error)}`,
        { workflow: request.workflow, ref: request.ref, expected_head: request.expected_head },
        { httpStatus: 502, mayHaveMutated: true },
      );
    }
    if (dispatch.status !== 200 && dispatch.status !== 204) {
      githubFailure(dispatch, 'workflow_dispatch.dispatch', { mayHaveMutated: false });
    }

    for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt += 1) {
      const runs = await apiClient.call('github', {
        path: `${workflowPath}/runs`,
        method: 'GET',
        query: { branch: request.ref, event: 'workflow_dispatch', per_page: 10 },
      });
      if (runs.status !== 200) {
        throw failure(
          'GITHUB_WORKFLOW_DISPATCH_IDENTITY_UNCONFIRMED',
          'workflow was dispatched but run identity could not be read back',
          { workflow: request.workflow, ref: request.ref, expected_head: request.expected_head, upstream_status: runs.status },
          { httpStatus: 502, mayHaveMutated: true },
        );
      }
      const run = recentMatchingRun(runs.body?.workflow_runs, request.expected_head, dispatchStartedAt, requestId);
      if (run) {
        return {
          ok: true,
          dispatched: true,
          repo: request.repo,
          workflow: request.workflow,
          ref: request.ref,
          expected_head: request.expected_head,
          workflow_run_id: Number(run.id) || null,
          workflow_run_head_sha: String(run.head_sha || '').toLowerCase() || null,
          workflow_run_status: run.status || null,
          workflow_run_conclusion: run.conclusion || null,
          workflow_run_html_url: run.html_url || null,
          precondition_verified: true,
          mutation_certainty: 'confirmed',
          may_have_mutated: true,
        };
      }
      if (attempt < MAX_CONFIRM_ATTEMPTS - 1) await sleep(CONFIRM_DELAY_MS);
    }

    throw failure(
      'GITHUB_WORKFLOW_DISPATCH_IDENTITY_UNCONFIRMED',
      requestId
        ? 'workflow was dispatched but no run carrying request_id at expected_head was observed'
        : 'workflow was dispatched but no run at expected_head was observed',
      { workflow: request.workflow, ref: request.ref, expected_head: request.expected_head, request_id: requestId || null },
      { httpStatus: 409, mayHaveMutated: true },
    );
  }, { permissionProfile: 'workflow_dispatch' });
}

export { normalizeRequest as normalizeGitHubWorkflowDispatchRequest };
