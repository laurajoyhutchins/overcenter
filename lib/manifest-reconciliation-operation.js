const SHA256 = /^[0-9a-f]{64}$/;
const RECEIPT_PATH = 'public/.overcenter/source-materialization.json';

export const MANIFEST_RECONCILIATION_SCHEMA = 'manifest-reconciliation-v1';
export const MANIFEST_RECONCILIATION_RECEIPT_SCHEMA = 'manifest-reconciliation-receipt-v1';
export const MANIFEST_RECONCILIATION_RECEIPT_PATH = RECEIPT_PATH;

export class ManifestReconciliationFailure extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ManifestReconciliationFailure';
    this.code = code;
    this.may_have_mutated = options.may_have_mutated === true;
    this.recovery_required = options.recovery_required === true;
    this.automatic_retry = options.automatic_retry === true;
    this.details = options.details || null;
  }
}

function fail(code, message = code, options = {}) {
  throw new ManifestReconciliationFailure(code, message, options);
}
function positiveVersion(value, field) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `${field} must be a positive integer`);
  return version;
}
function sha(value, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA256.test(normalized)) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `${field} must be a sha256 digest`);
  return normalized;
}
function requiredText(value, field) {
  const text = String(value || '').trim();
  if (!text) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `${field} is required`);
  return text;
}
function requiredPort(ports, name) {
  const port = ports?.[name];
  if (typeof port !== 'function') fail('MANIFEST_RECONCILIATION_PROVIDER_INVALID', `${name} port is required`);
  return port;
}
function safePath(value, field) {
  const path = String(value || '');
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `${field} contains an invalid path`);
  }
  return path;
}
function normalizeDesired(files) {
  if (!Array.isArray(files)) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', 'desired_files must be an array');
  const seen = new Set();
  const result = files.map((file, index) => {
    const path = safePath(file?.path, `desired_files[${index}].path`);
    if (path === RECEIPT_PATH || seen.has(path)) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `duplicate or reserved desired path: ${path}`);
    seen.add(path);
    const size = Number(file?.size);
    if (!Number.isSafeInteger(size) || size < 0) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `desired_files[${index}].size is invalid`);
    return Object.freeze({ path, hash: sha(file?.hash, `desired_files[${index}].hash`), size });
  });
  return Object.freeze(result.sort((a, b) => a.path.localeCompare(b.path)));
}
function normalizeWrites(writes) {
  if (!Array.isArray(writes)) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', 'writes must be an array');
  const seen = new Set();
  const result = writes.map((write, index) => {
    const path = safePath(write?.path, `writes[${index}].path`);
    if (seen.has(path)) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `duplicate write path: ${path}`);
    if (typeof write?.content !== 'string' || write.content.includes('\u0000')) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `writes[${index}].content must be UTF-8 text`);
    seen.add(path);
    return Object.freeze({ path, content: write.content });
  });
  return Object.freeze(result.sort((a, b) => a.path.localeCompare(b.path)));
}
function normalizeDeletes(deletes) {
  if (!Array.isArray(deletes)) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', 'deletes must be an array');
  const unique = new Set();
  for (const raw of deletes) {
    const path = safePath(raw, 'deletes');
    if (path === RECEIPT_PATH || unique.has(path)) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', `duplicate or reserved delete path: ${path}`);
    unique.add(path);
  }
  return Object.freeze([...unique].sort());
}
async function sha256Text(content) {
  const bytes = new TextEncoder().encode(content);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function normalizedFileMap(files) {
  if (!Array.isArray(files)) fail('MANIFEST_RECONCILIATION_PROVIDER_INVALID', 'provider file observation must be an array');
  const map = new Map();
  for (const file of files) {
    if (file?.virtual) continue;
    const path = String(file?.path || '');
    if (!path || map.has(path)) continue;
    map.set(path, { hash:String(file?.hash || file?.sha256 || '').trim().toLowerCase(), size:Number(file?.size) });
  }
  return map;
}
async function manifestMatches(files, request, { requireSize, requireReceipt }) {
  const observed = normalizedFileMap(files);
  const expectedPaths = new Set(request.desired_files.map(file => file.path));
  if (requireReceipt) expectedPaths.add(RECEIPT_PATH);
  for (const path of observed.keys()) {
    if (!expectedPaths.has(path)) return false;
  }
  for (const file of request.desired_files) {
    const candidate = observed.get(file.path);
    if (!candidate || candidate.hash !== file.hash || (requireSize && candidate.size !== file.size)) return false;
  }
  for (const path of request.deletes) {
    if (observed.has(path)) return false;
  }
  if (!requireReceipt) return true;
  const receipt = observed.get(RECEIPT_PATH);
  if (!receipt) return false;
  const receiptHash = await sha256Text(request.receipt_content);
  return receipt.hash === receiptHash && receipt.size === new TextEncoder().encode(request.receipt_content).byteLength;
}
function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', 'request must be an object');
  const expected = positiveVersion(raw.expected_version, 'expected_version');
  const target = positiveVersion(raw.target_version, 'target_version');
  if (target !== expected + 1) fail('MANIFEST_RECONCILIATION_REQUEST_INVALID', 'target_version must be the immediate successor of expected_version');
  return Object.freeze({
    project: requiredText(raw.project, 'project'),
    expected_version: expected,
    target_version: target,
    manifest_sha256: sha(raw.manifest_sha256, 'manifest_sha256'),
    reconciliation_sha256: sha(raw.reconciliation_sha256, 'reconciliation_sha256'),
    desired_files: normalizeDesired(raw.desired_files),
    writes: normalizeWrites(raw.writes),
    deletes: normalizeDeletes(raw.deletes),
    receipt_content: requiredText(raw.receipt_content, 'receipt_content'),
  });
}
async function success(request, immutable, { idempotent, mutationAttempted }) {
  return Object.freeze({
    ok:true,
    schema:MANIFEST_RECONCILIATION_RECEIPT_SCHEMA,
    project:request.project,
    expected_version:request.expected_version,
    deployment_version:request.target_version,
    manifest_sha256:request.manifest_sha256,
    reconciliation_sha256:request.reconciliation_sha256,
    idempotent:idempotent === true,
    mutation_attempted:mutationAttempted === true,
    provider_atomic:false,
    provider_receipt_sha256:await sha256Text(request.receipt_content),
    immutable_files:Object.freeze([...(immutable?.files || [])]),
  });
}

export async function reconcileManifest(rawRequest, ports = {}) {
  const request = normalizeRequest(rawRequest);
  const inspectVersion = requiredPort(ports, 'inspectVersion');
  const inspectImmutable = requiredPort(ports, 'inspectImmutable');
  const deleteFile = requiredPort(ports, 'deleteFile');
  const writeFiles = requiredPort(ports, 'writeFiles');
  const inspectDraft = requiredPort(ports, 'inspectDraft');
  const dryRun = requiredPort(ports, 'dryRun');
  const deploy = requiredPort(ports, 'deploy');

  const observedVersion = positiveVersion(await inspectVersion(request.project), 'provider version');
  if (observedVersion !== request.expected_version) {
    if (observedVersion === request.target_version) {
      const immutable = await inspectImmutable(request.project, request.target_version);
      if (positiveVersion(immutable?.version, 'immutable version') === request.target_version
          && await manifestMatches(immutable?.files, request, { requireSize:true, requireReceipt:true })) {
        return success(request, immutable, { idempotent:true, mutationAttempted:false });
      }
    }
    fail('MANIFEST_RECONCILIATION_VERSION_MISMATCH', 'project version drifted before manifest reconciliation', {
      may_have_mutated:false,
      details:{ expected_version:request.expected_version, observed_version:observedVersion },
    });
  }

  let mutationAttempted = false;
  try {
    for (const path of request.deletes) {
      mutationAttempted = true;
      await deleteFile(request.project, path, request);
    }
    if (request.writes.length) {
      mutationAttempted = true;
      await writeFiles(request.project, request.writes, request);
    }

    const draft = await inspectDraft(request.project);
    if (positiveVersion(draft?.version, 'draft version') !== request.expected_version
        || !await manifestMatches(draft?.files, request, { requireSize:false, requireReceipt:true })) {
      fail('MANIFEST_RECONCILIATION_DRAFT_MISMATCH', 'staged manifest does not match the desired manifest', { may_have_mutated:mutationAttempted });
    }
    const dryRunResult = await dryRun(request.project, request);
    if (Array.isArray(dryRunResult?.errors) && dryRunResult.errors.length) {
      fail('MANIFEST_RECONCILIATION_DRY_RUN_FAILED', 'provider dry-run rejected the reconciled manifest', { may_have_mutated:mutationAttempted });
    }

    mutationAttempted = true;
    await deploy(request.project, request);
    const immutable = await inspectImmutable(request.project, request.target_version);
    if (positiveVersion(immutable?.version, 'immutable version') !== request.target_version
        || !await manifestMatches(immutable?.files, request, { requireSize:true, requireReceipt:true })) {
      fail('MANIFEST_RECONCILIATION_IMMUTABLE_MISMATCH', 'immutable deployment does not match the reconciled manifest', { may_have_mutated:true });
    }
    return success(request, immutable, { idempotent:false, mutationAttempted });
  } catch (error) {
    if (error instanceof ManifestReconciliationFailure) throw error;
    fail('MANIFEST_RECONCILIATION_INDETERMINATE', 'provider outcome became uncertain during manifest reconciliation', {
      cause:error,
      may_have_mutated:mutationAttempted || error?.may_have_mutated === true,
      recovery_required:true,
      automatic_retry:false,
      details:{ reconciliation_sha256:request.reconciliation_sha256 },
    });
  }
}
