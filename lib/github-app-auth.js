import { config } from "hatchable";
import { boundedSafeRead, githubTransportEvidence } from "lib/github-transport.js";

const API_VERSION = "2026-03-10";
const USER_AGENT = "Overcenter/1.0";

// GitHub capabilities are command-owned. Callers can inspect this fixed catalog,
// but cannot supply arbitrary permissions or fallback transports.
const GITHUB_APP_CAPABILITIES = Object.freeze({
  changeset: Object.freeze({ permissions: Object.freeze({ contents: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  workflow_changeset: Object.freeze({ permissions: Object.freeze({ contents: "write", workflows: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  delete_branch: Object.freeze({ permissions: Object.freeze({ contents: "write", pull_requests: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  review_packet: Object.freeze({ permissions: Object.freeze({ pull_requests: "read", metadata: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  project_facts: Object.freeze({ permissions: Object.freeze({ contents: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  review_pull_requests: Object.freeze({ permissions: Object.freeze({ pull_requests: "read" }), fallback: Object.freeze({ class: "degraded_observation", mechanism: "partial_review_packet" }) }),
  review_checks: Object.freeze({ permissions: Object.freeze({ checks: "read" }), fallback: Object.freeze({ class: "degraded_observation", mechanism: "partial_review_packet" }) }),
  review_statuses: Object.freeze({ permissions: Object.freeze({ statuses: "read" }), fallback: Object.freeze({ class: "degraded_observation", mechanism: "partial_review_packet" }) }),
  required_checks: Object.freeze({ permissions: Object.freeze({ administration: "write", checks: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  branch_policy: Object.freeze({ permissions: Object.freeze({ administration: "write", checks: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  repository_metadata: Object.freeze({ permissions: Object.freeze({ administration: "write", metadata: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  repository_template: Object.freeze({ permissions: Object.freeze({ administration: "write", metadata: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  repository_from_template: Object.freeze({ permissions: Object.freeze({ administration: "write", contents: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  milestone: Object.freeze({ permissions: Object.freeze({ pull_requests: "write", metadata: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  release: Object.freeze({ permissions: Object.freeze({ contents: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  stack_reconcile: Object.freeze({ permissions: Object.freeze({ pull_requests: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  pull_request_create: Object.freeze({ permissions: Object.freeze({ contents: "read", pull_requests: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  pull_request_mark_ready: Object.freeze({ permissions: Object.freeze({ contents: "write", pull_requests: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  pull_request_close: Object.freeze({ permissions: Object.freeze({ pull_requests: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  issue_close: Object.freeze({ permissions: Object.freeze({ issues: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  integration_merge: Object.freeze({ permissions: Object.freeze({ contents: "write", pull_requests: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  integration_update: Object.freeze({ permissions: Object.freeze({ contents: "write", pull_requests: "write" }), fallback: Object.freeze({ class: "equivalent_fallback", mechanism: "isolated_worktree_update" }) }),
  default_branch_migrate: Object.freeze({ permissions: Object.freeze({ administration: "write", contents: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  actions_storage_read: Object.freeze({ permissions: Object.freeze({ actions: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  actions_storage_delete: Object.freeze({ permissions: Object.freeze({ actions: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  production_materialization_dispatch: Object.freeze({ permissions: Object.freeze({ actions: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  actions_retention: Object.freeze({ permissions: Object.freeze({ administration: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  pages_ensure: Object.freeze({ permissions: Object.freeze({ pages: "write", administration: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  pages_dispatch: Object.freeze({ permissions: Object.freeze({ actions: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  workflow_dispatch: Object.freeze({ permissions: Object.freeze({ actions: "write" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
  portfolio_reconcile: Object.freeze({ permissions: Object.freeze({ metadata: "read", issues: "read" }), fallback: Object.freeze({ class: "fail_closed", mechanism: null }) }),
});

const PERMISSION_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(GITHUB_APP_CAPABILITIES).map(([name, entry]) => [name, entry.permissions]),
));

function permissionProfile(name) {
  const permissions = PERMISSION_PROFILES[name];
  if (!permissions) {
    throw Object.assign(new Error("Unknown internal GitHub App permission profile."), {
      code: "INVALID_GITHUB_APP_PERMISSION_PROFILE",
    });
  }
  return { ...permissions };
}

export function githubAppPermissionProfile(name) {
  return permissionProfile(name);
}

export function githubAppChangesetPermissionProfile(paths = []) {
  const values = Array.isArray(paths) ? paths : [];
  const touchesWorkflow = values.some(value => {
    const path = typeof value === 'string' ? value : '';
    return path === '.github/workflows' || path.startsWith('.github/workflows/');
  });
  return touchesWorkflow ? 'workflow_changeset' : 'changeset';
}

export function githubAppCapabilityCatalog() {
  return Object.fromEntries(Object.entries(GITHUB_APP_CAPABILITIES).map(([name, entry]) => [name, {
    permissions: { ...entry.permissions },
    fallback: { ...entry.fallback },
  }]));
}

export function githubAppFallbackPolicy(name) {
  const entry = GITHUB_APP_CAPABILITIES[name];
  if (!entry) {
    throw Object.assign(new Error("Unknown internal GitHub App capability."), {
      code: "INVALID_GITHUB_APP_CAPABILITY",
    });
  }
  return { ...entry.fallback };
}

function capabilityProbeFailure(error) {
  const message = String(error?.message || "GitHub App capability probe failed.");
  const status = Number(error?.status || 0);
  if ([401, 403, 422].includes(status) && /permission|access|granted|not permitted|resource not accessible/i.test(message)) {
    return { permission_available: false, reason: "permission_denied", error: "GITHUB_APP_PERMISSION_DENIED", ...(status ? { upstream_status: status } : {}) };
  }
  if (status === 404) {
    return { permission_available: false, reason: "installation_not_found", error: "GITHUB_APP_INSTALLATION_NOT_FOUND", upstream_status: 404 };
  }
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return { permission_available: false, reason: "setup_required", error: "GITHUB_APP_SETUP_REQUIRED" };
  }
  return { permission_available: false, reason: "probe_failed", error: error?.code || "GITHUB_APP_AUTH_ERROR", ...(status ? { upstream_status: status } : {}) };
}

export async function inspectGitHubAppCapabilities(repoInput, options = {}) {
  const repo = validateRepo(repoInput);
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  const capabilities = {};
  const probeCache = new Map();

  for (const [name, entry] of Object.entries(GITHUB_APP_CAPABILITIES)) {
    const permissionKey = JSON.stringify(entry.permissions);
    let probe = probeCache.get(permissionKey);
    if (!probe) {
      try {
        await withApp(repo, async () => ({ ok: true }), { permissionProfile: name });
        probe = { permission_available: true, reason: null, error: null };
      } catch (error) {
        probe = capabilityProbeFailure(error);
      }
      probeCache.set(permissionKey, probe);
    }
    capabilities[name] = {
      permissions: { ...entry.permissions },
      permission_available: probe.permission_available,
      ...(probe.reason ? { unavailable_reason: probe.reason } : {}),
      ...(probe.error ? { error: probe.error } : {}),
      ...(probe.upstream_status ? { upstream_status: probe.upstream_status } : {}),
      fallback: { ...entry.fallback },
    };
  }

  return {
    ok: true,
    repo,
    fallback_taxonomy: ["equivalent_fallback", "degraded_observation", "fail_closed"],
    capabilities,
  };
}

const SHA256_DIGEST_INFO_PREFIX = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03,
  0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function utf8Base64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function pemBodyToBytes(pem, label) {
  const normalized = String(pem || "").trim();
  const start = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  if (!normalized.includes(start) || !normalized.includes(end)) return null;
  const body = normalized
    .slice(normalized.indexOf(start) + start.length, normalized.indexOf(end))
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readDer(bytes, offset = 0, expectedTag = null) {
  if (offset >= bytes.length) throw new Error("Unexpected end of DER data.");
  const tag = bytes[offset++];
  if (expectedTag !== null && tag !== expectedTag) {
    throw new Error(`Unexpected DER tag 0x${tag.toString(16)}.`);
  }
  if (offset >= bytes.length) throw new Error("Missing DER length.");
  let length = bytes[offset++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || offset + count > bytes.length) {
      throw new Error("Invalid DER length.");
    }
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[offset++];
  }
  const start = offset;
  const end = start + length;
  if (end > bytes.length) throw new Error("DER length exceeds input.");
  return { start, end, next: end, content: bytes.subarray(start, end) };
}

function extractPkcs1(privateKeyValue) {
  const normalized = String(privateKeyValue || "").trim();

  const pkcs1 = pemBodyToBytes(normalized, "RSA PRIVATE KEY");
  if (pkcs1) return pkcs1;

  let pkcs8 = pemBodyToBytes(normalized, "PRIVATE KEY");

  // Hatchable's secret editor may store the base64 DER body without the PEM
  // wrapper. Accept that representation and identify PKCS#1 vs PKCS#8 from DER.
  if (!pkcs8 && normalized && !normalized.includes("-----BEGIN")) {
    const body = normalized.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
      throw new Error("Private key must be PEM or base64 DER PKCS#1/PKCS#8 RSA.");
    }
    const binary = atob(body);
    const bare = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bare[i] = binary.charCodeAt(i);

    const root = readDer(bare, 0, 0x30);
    let offset = root.start;
    const version = readDer(bare, offset, 0x02);
    offset = version.next;
    if (bare[offset] === 0x02) return bare;
    if (bare[offset] === 0x30) pkcs8 = bare;
  }

  if (!pkcs8) throw new Error("Private key must be PEM or base64 DER PKCS#1/PKCS#8 RSA.");

  const root = readDer(pkcs8, 0, 0x30);
  let offset = root.start;
  const version = readDer(pkcs8, offset, 0x02);
  offset = version.next;
  const algorithm = readDer(pkcs8, offset, 0x30);
  offset = algorithm.next;
  const privateKey = readDer(pkcs8, offset, 0x04);
  return privateKey.content;
}

function unsignedIntegerBytes(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return bytes.subarray(start);
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value, length) {
  const out = new Uint8Array(length);
  let n = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new Error("Integer does not fit output length.");
  return out;
}

function parseRsaPrivateKey(privateKeyValue) {
  try {
    const pkcs1 = extractPkcs1(privateKeyValue);
    const root = readDer(pkcs1, 0, 0x30);
    let offset = root.start;
    const fields = [];
    while (offset < root.end && fields.length < 4) {
      const field = readDer(pkcs1, offset, 0x02);
      fields.push(field.content);
      offset = field.next;
    }
    if (fields.length < 4) throw new Error("RSA private key is missing required integers.");
    const modulusBytes = unsignedIntegerBytes(fields[1]);
    return {
      n: bytesToBigInt(modulusBytes),
      d: bytesToBigInt(unsignedIntegerBytes(fields[3])),
      modulusLength: modulusBytes.length,
    };
  } catch (error) {
    throw Object.assign(
      new Error(`Unable to parse GitHub App RSA private key: ${error.message}`),
      { code: "INVALID_GITHUB_APP_PRIVATE_KEY" },
    );
  }
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    if (e > 0n) b = (b * b) % modulus;
  }
  return result;
}

async function encodedMessage(signingInput, modulusLength) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signingInput)),
  );
  const digestInfo = concatBytes(SHA256_DIGEST_INFO_PREFIX, digest);
  const paddingLength = modulusLength - digestInfo.length - 3;
  if (paddingLength < 8) throw new Error("RSA modulus is too short for RS256.");
  const padding = new Uint8Array(paddingLength);
  padding.fill(0xff);
  return concatBytes(
    Uint8Array.of(0x00, 0x01),
    padding,
    Uint8Array.of(0x00),
    digestInfo,
  );
}

// Temporary signing shim. Hatchable's isolate currently lacks RSA import/sign
// support; replace this module-level implementation when native github_app auth
// or native RSA signing lands (platform feedback #156/#162).
async function signRs256(signingInput, privateKeyValue) {
  const key = parseRsaPrivateKey(privateKeyValue);
  const encoded = await encodedMessage(signingInput, key.modulusLength);
  const message = bytesToBigInt(encoded);
  if (message >= key.n) throw new Error("Encoded message exceeds RSA modulus.");
  return bigIntToBytes(modPow(message, key.d, key.n), key.modulusLength);
}

async function createGitHubAppJwt({ appId, privateKeyValue }) {
  const issuer = String(appId || "").trim();
  if (!/^\d+$/.test(issuer)) {
    throw Object.assign(new Error("GITHUB_APP_ID must be the numeric GitHub App ID."), {
      code: "INVALID_GITHUB_APP_ID",
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: issuer };
  const signingInput = `${utf8Base64Url(JSON.stringify(header))}.${utf8Base64Url(JSON.stringify(payload))}`;
  const signature = await signRs256(signingInput, privateKeyValue);
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

async function githubRawRequest(path, { token, method = "GET", body, query, headers = {} } = {}) {
  const url = new URL(`https://api.github.com${path}`);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url.toString(), {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
      ...headers,
      ...(body === undefined
        ? {}
        : { "Content-Type": headers["Content-Type"] || "application/json" }),
    },
    body: body === undefined
      ? undefined
      : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return {
    status: response.status,
    body: parsed,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function githubRequest(path, options = {}) {
  const phase = options.phase || null;
  const method = String(options.method || "GET").toUpperCase();
  const mayHaveMutated = options.mayHaveMutated === undefined ? method !== "GET" : Boolean(options.mayHaveMutated);
  let result;
  let attempts = 1;
  try {
    if (options.retrySafeRead) {
      const retried = await boundedSafeRead(
        () => githubRawRequest(path, options),
        { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
      );
      result = retried.response;
      attempts = retried.attempts;
    } else {
      result = await githubRawRequest(path, options);
    }
  } catch (error) {
    const finalAttempts = Number(error?.githubTransportAttempts || attempts || 1);
    throw Object.assign(new Error(String(error?.message || "GitHub transport failed.")), {
      code: "GITHUB_APP_TRANSPORT_ERROR",
      status: Number(error?.status || 0) || null,
      githubPath: path,
      phase,
      githubRequestId: error?.githubRequestId || null,
      retryAfter: error?.retryAfter || null,
      attempts: finalAttempts,
      mayHaveMutated,
      headers: error?.headers || null,
    });
  }

  if (result.status < 200 || result.status >= 300) {
    const message = typeof result.body === "object" && result.body?.message
      ? result.body.message
      : `GitHub returned HTTP ${result.status}`;
    const evidence = githubTransportEvidence(result, { phase, path, attempts, mayHaveMutated });
    throw Object.assign(new Error(message), {
      code: "GITHUB_APP_UPSTREAM_ERROR",
      status: result.status,
      githubPath: path,
      phase: evidence.phase,
      githubRequestId: evidence.github_request_id,
      retryAfter: evidence.retry_after,
      attempts: evidence.attempts,
      mayHaveMutated: evidence.may_have_mutated,
      headers: result.headers || null,
    });
  }
  return result;
}

function validateRepo(repo) {
  const value = String(repo || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw Object.assign(new Error("repo must be in owner/name form."), { code: "INVALID_REPO" });
  }
  return value;
}

const INSTALLATION_CACHE_TTL_MS = 60 * 60 * 1000;
const installationIdentityCache = new Map();

async function lookupInstallationId(repo, jwt) {
  const [owner, name] = repo.split("/");
  const installation = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    {
      token: jwt,
      phase: "auth.installation_lookup",
      mayHaveMutated: false,
    },
  );
  const installationId = Number(installation.body?.id || 0);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw Object.assign(new Error("GitHub did not return an installation id."), {
      code: "GITHUB_APP_INSTALLATION_NOT_FOUND",
      phase: "auth.installation_lookup",
      githubPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      mayHaveMutated: false,
    });
  }
  return installationId;
}

function createInstallationResolver(options = {}) {
  const lookup = options.lookup || lookupInstallationId;
  const now = options.now || Date.now;
  const sleep = options.sleep;
  const random = options.random;
  const cache = options.cache || installationIdentityCache;
  const ttlMs = Math.max(1000, Number(options.ttlMs || INSTALLATION_CACHE_TTL_MS));

  return {
    async resolve(repo, jwt) {
      const cached = cache.get(repo);
      const current = Number(now());
      if (cached && cached.expiresAt > current) return cached.installationId;

      let retried;
      try {
        retried = await boundedSafeRead(async () => {
          const installationId = await lookup(repo, jwt);
          return { status: 200, body: { installationId }, headers: {} };
        }, { sleep, random, maxAttempts: 3 });
      } catch (error) {
        if (error && typeof error === 'object') {
          if (error.githubTransportAttempts) error.attempts = Number(error.githubTransportAttempts);
          if (error.mayHaveMutated === undefined) error.mayHaveMutated = false;
        }
        throw error;
      }
      const installationId = Number(retried.response?.body?.installationId || 0);
      if (!Number.isInteger(installationId) || installationId <= 0) {
        throw Object.assign(new Error("GitHub did not return a valid installation id."), {
          code: "GITHUB_APP_INSTALLATION_NOT_FOUND",
          phase: "auth.installation_lookup",
          attempts: retried.attempts,
          mayHaveMutated: false,
        });
      }
      cache.set(repo, { installationId, expiresAt: current + ttlMs });
      return installationId;
    },
    invalidate(repo) {
      cache.delete(repo);
    },
  };
}

const installationResolver = createInstallationResolver();

export async function getGitHubAppIdentity() {
  const appId = await config.get("GITHUB_APP_ID");
  const privateKeyValue = await config.get("GITHUB_APP_PRIVATE_KEY");
  const jwt = await createGitHubAppJwt({ appId, privateKeyValue });
  const response = await githubRequest("/app", {
    token: jwt,
    phase: "auth.app_identity",
    retrySafeRead: true,
    mayHaveMutated: false,
  });
  return {
    id: Number(response.body?.id || 0) || null,
    client_id: response.body?.client_id || null,
    slug: response.body?.slug || null,
    owner_login: response.body?.owner?.login || null,
    permissions: response.body?.permissions || {},
  };
}

export async function getGitHubAppInstallationScope(repoInput) {
  const repo = validateRepo(repoInput);
  const [owner, name] = repo.split("/");
  const appId = await config.get("GITHUB_APP_ID");
  const privateKeyValue = await config.get("GITHUB_APP_PRIVATE_KEY");
  const jwt = await createGitHubAppJwt({ appId, privateKeyValue });
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`;
  const response = await githubRequest(path, {
    token: jwt,
    phase: "auth.installation_scope",
    retrySafeRead: true,
    mayHaveMutated: false,
  });
  const installationId = Number(response.body?.id || 0);
  const repositorySelection = String(response.body?.repository_selection || "").toLowerCase();
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw Object.assign(new Error("GitHub did not return an installation id."), {
      code: "GITHUB_APP_INSTALLATION_NOT_FOUND",
      phase: "auth.installation_scope",
      githubPath: path,
      mayHaveMutated: false,
    });
  }
  if (!new Set(["all", "selected"]).has(repositorySelection)) {
    throw Object.assign(new Error("GitHub did not return a recognized repository_selection for the installation."), {
      code: "GITHUB_APP_INSTALLATION_SCOPE_UNKNOWN",
      phase: "auth.installation_scope",
      githubPath: path,
      mayHaveMutated: false,
    });
  }
  return {
    repository: repo,
    installation_id: installationId,
    repository_selection: repositorySelection,
    account_login: response.body?.account?.login || null,
    target_type: response.body?.target_type || null,
  };
}

function installationTokenRequestBody(repo, profileName, repositoryScope = "repository") {
  const scope = repositoryScope == null ? "repository" : String(repositoryScope);
  if (scope !== "repository" && scope !== "installation") throw Object.assign(new Error("Unknown internal GitHub App token repository scope."), { code: "INVALID_GITHUB_APP_TOKEN_REPOSITORY_SCOPE" });
  const permissions = permissionProfile(profileName);
  if (scope === "installation") {
    if (profileName !== "repository_from_template") throw Object.assign(new Error("Installation-wide GitHub App tokens are reserved for repository template generation."), { code: "GITHUB_APP_INSTALLATION_WIDE_TOKEN_FORBIDDEN" });
    return { permissions };
  }
  const [, name] = repo.split("/");
  return { repositories: [name], permissions };
}

async function createInstallationToken(repo, profileName, options = {}) {
  const repositoryScope = options.repositoryScope || "repository";
  const appId = await config.get("GITHUB_APP_ID");
  const privateKeyValue = await config.get("GITHUB_APP_PRIVATE_KEY");
  const jwt = await createGitHubAppJwt({ appId, privateKeyValue });

  async function mintToken(installationId) {
    return githubRequest(`/app/installations/${installationId}/access_tokens`, {
      token: jwt,
      method: "POST",
      phase: "auth.token_mint",
      mayHaveMutated: false,
      body: installationTokenRequestBody(repo, profileName, repositoryScope),
    });
  }

  let installationId = await installationResolver.resolve(repo, jwt);
  let tokenResponse;
  try {
    tokenResponse = await mintToken(installationId);
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
    installationResolver.invalidate(repo);
    installationId = await installationResolver.resolve(repo, jwt);
    tokenResponse = await mintToken(installationId);
  }

  const token = tokenResponse.body?.token;
  if (!token) {
    throw Object.assign(new Error("GitHub did not return an installation access token."), {
      code: "GITHUB_APP_TOKEN_MISSING",
      phase: "auth.token_mint",
      githubPath: `/app/installations/${installationId}/access_tokens`,
      mayHaveMutated: false,
    });
  }
  return { token, installationId, expiresAt: tokenResponse.body?.expires_at || null };
}

export async function createEncryptedGitHubInstallationLease(repoInput, profileName, encryptToken) {
  const repo = validateRepo(repoInput);
  if (typeof encryptToken !== "function") throw new Error("encryptToken callback is required");
  const auth = await createInstallationToken(repo, profileName);
  const ciphertext = await encryptToken(auth.token);
  if (typeof ciphertext !== "string" || !ciphertext) throw new Error("encrypted installation lease must be a non-empty string");
  if (ciphertext.includes(auth.token)) throw new Error("encrypted installation lease leaked plaintext token material");
  return {
    repository: repo,
    installation_id: auth.installationId,
    expires_at: auth.expiresAt,
    ciphertext,
  };
}

async function withInstallationTokenClient(auth, callback, deps = {}) {
  const rawRequest = deps.rawRequest || githubRawRequest;
  const revokeRequest = deps.revokeRequest || githubRequest;
  const apiClient = {
    async call(name, callOptions = {}) {
      if (name !== "github") throw new Error(`GitHub App client cannot call API ${name}.`);
      return rawRequest(callOptions.path, {
        token: auth.token,
        method: callOptions.method || "GET",
        body: callOptions.body,
        query: callOptions.query,
        headers: callOptions.headers || {},
      });
    },
    async graphql(query, variables = {}) {
      return rawRequest("/graphql", {
        token: auth.token,
        method: "POST",
        body: { query, variables },
        headers: { Accept: "application/json" },
      });
    },
  };

  try {
    return await callback(apiClient);
  } finally {
    try {
      await revokeRequest("/installation/token", { token: auth.token, method: "DELETE" });
    } catch {
      // The token remains short-lived if explicit revocation fails. It is never
      // returned to callers, persisted, or logged.
    }
  }
}

export async function withGitHubAppApiClient(repoInput, callback, options = {}) {
  const repo = validateRepo(repoInput);
  const profileName = options.permissionProfile || "changeset";
  const auth = await createInstallationToken(repo, profileName, { repositoryScope: options.repositoryScope });
  return withInstallationTokenClient(auth, callback);
}

export async function runGitHubAppAuthRegressionTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }
  function check(condition, message) { if (!condition) throw new Error(message); }

  await test("changeset permission profile remains contents write only", async () => {
    check(JSON.stringify(permissionProfile("changeset")) === JSON.stringify({ contents: "write" }), "changeset scope changed");
  });
  await test("workflow changesets add only the GitHub-required workflow permission", async () => {
    check(JSON.stringify(permissionProfile("workflow_changeset")) === JSON.stringify({ contents: "write", workflows: "write" }), "workflow changeset scope changed");
    check(githubAppChangesetPermissionProfile(["README.md", "docs/reference.md"]) === "changeset", "ordinary paths requested workflow permission");
    check(githubAppChangesetPermissionProfile([".github/workflows/ci.yml"]) === "workflow_changeset", "workflow path did not request workflow permission");
    check(githubAppChangesetPermissionProfile([".github/workflows-not-really/ci.yml"]) === "changeset", "workflow prefix matching is too broad");
    const ordinary = permissionProfile("changeset");
    check(!("workflows" in ordinary), "workflow permission leaked into ordinary repository mutation");
  });
  await test("branch deletion permission profile adds only PR read for lifecycle safety", async () => {
    check(JSON.stringify(permissionProfile("delete_branch")) === JSON.stringify({ contents: "write", pull_requests: "read" }), "branch deletion scope changed");
  });
  await test("review permissions cannot leak into changeset profile", async () => {
    const changeset = permissionProfile("changeset");
    check(!("pull_requests" in changeset) && !("checks" in changeset) && !("statuses" in changeset) && !("administration" in changeset), "review permission leaked");
  });
  await test("review packet identity profile is read-only", async () => {
    const profile = permissionProfile("review_packet");
    check(JSON.stringify(profile) === JSON.stringify({ pull_requests: "read", metadata: "read" }), "review packet identity scope is not the expected read-only profile");
    check(!Object.values(profile).includes("write"), "review packet identity profile still requests write access");
  });
  await test("fallback taxonomy is closed and command-owned", async () => {
    const catalog = githubAppCapabilityCatalog();
    const allowed = new Set(["equivalent_fallback", "degraded_observation", "fail_closed"]);
    check(Object.keys(catalog).length > 0, "capability catalog is empty");
    for (const [name, entry] of Object.entries(catalog)) {
      check(allowed.has(entry.fallback.class), `${name} has an unknown fallback class`);
      check(JSON.stringify(entry.permissions) === JSON.stringify(permissionProfile(name)), `${name} permission profile diverged from capability catalog`);
    }
  });
  await test("only standalone integration update has an equivalent mutation fallback", async () => {
    const catalog = githubAppCapabilityCatalog();
    const equivalents = Object.entries(catalog).filter(([, entry]) => entry.fallback.class === "equivalent_fallback").map(([name]) => name);
    check(JSON.stringify(equivalents) === JSON.stringify(["integration_update"]), `unexpected equivalent mutation fallbacks: ${equivalents.join(",")}`);
    check(githubAppFallbackPolicy("integration_update").mechanism === "isolated_worktree_update", "standalone update fallback mechanism changed");
    check(githubAppFallbackPolicy("stack_reconcile").class === "fail_closed", "stack reconciliation must fail closed");
  });
  await test("pull-request creation is a command-owned fail-closed mutation", async () => {
    const catalog = githubAppCapabilityCatalog();
    const capability = catalog.pull_request_create;
    check(Boolean(capability), "pull_request_create capability is missing");
    check(JSON.stringify(capability.permissions) === JSON.stringify({ contents: "read", pull_requests: "write" }), "pull-request creation does not use the narrow refs-read + PR-write profile");
    check(capability.fallback.class === "fail_closed" && capability.fallback.mechanism === null, "pull-request creation unexpectedly gained an alternate mutation transport");
  });
  await test("draft graduation is a command-owned fail-closed pull-request mutation", async () => {
    const catalog = githubAppCapabilityCatalog();
    const capability = catalog.pull_request_mark_ready;
    check(Boolean(capability), "pull_request_mark_ready capability is missing");
    check(JSON.stringify(capability.permissions) === JSON.stringify({ contents: "write", pull_requests: "write" }), "draft graduation does not request the GitHub-required contents + pull_requests write pair");
    check(capability.fallback.class === "fail_closed" && capability.fallback.mechanism === null, "draft graduation unexpectedly gained an alternate mutation transport");
  });
  await test("optional review evidence degrades rather than fabricating satisfaction", async () => {
    check(githubAppFallbackPolicy("review_pull_requests").class === "degraded_observation", "PR review observation fallback changed");
    check(githubAppFallbackPolicy("review_checks").class === "degraded_observation", "checks observation fallback changed");
    check(githubAppFallbackPolicy("review_statuses").class === "degraded_observation", "statuses observation fallback changed");
  });
  await test("capability inspection reports permission denial without inventing a transport", async () => {
    const result = await inspectGitHubAppCapabilities("owner/repo", {
      withGitHubAppApiClient: async (_repo, callback, options) => {
        if (options.permissionProfile === "stack_reconcile") throw Object.assign(new Error("permissions not permitted"), { status: 422 });
        return callback({ call: async () => ({ status: 200, body: {} }) });
      },
    });
    check(result.ok === true, "capability inspection failed");
    check(result.capabilities.stack_reconcile.permission_available === false, "denied capability reported available");
    check(result.capabilities.stack_reconcile.fallback.class === "fail_closed", "denied stack capability gained a fallback");
    check(result.capabilities.integration_update.permission_available === true, "available capability reported unavailable");
  });
  await test("review observation permissions remain isolated", async () => {
    check(JSON.stringify(permissionProfile("review_pull_requests")) === JSON.stringify({ pull_requests: "read" }), "pull-request observation scope changed");
    check(JSON.stringify(permissionProfile("review_checks")) === JSON.stringify({ checks: "read" }), "checks scope changed");
    check(JSON.stringify(permissionProfile("review_statuses")) === JSON.stringify({ statuses: "read" }), "statuses scope changed");
  });
  await test("required-check administration scope is narrow and command-owned", async () => {
    check(JSON.stringify(permissionProfile("required_checks")) === JSON.stringify({ administration: "write", checks: "read" }), "required-check scope changed");
    const changeset = permissionProfile("changeset");
    check(!("administration" in changeset), "administration permission leaked into ordinary repository mutation");
  });
  await test("branch policy, stack, and default-branch mutation permissions remain command-owned", async () => {
    check(JSON.stringify(permissionProfile("branch_policy")) === JSON.stringify({ administration: "write", checks: "read" }), "branch-policy scope changed");
    check(JSON.stringify(permissionProfile("stack_reconcile")) === JSON.stringify({ pull_requests: "write" }), "stack scope changed");
    check(JSON.stringify(permissionProfile("integration_merge")) === JSON.stringify({ contents: "write", pull_requests: "write" }), "integration merge scope changed");
    check(JSON.stringify(permissionProfile("integration_update")) === JSON.stringify({ contents: "write", pull_requests: "write" }), "integration update scope changed");
    check(JSON.stringify(permissionProfile("default_branch_migrate")) === JSON.stringify({ administration: "write", contents: "write" }), "default-branch migration scope changed");
    const changeset = permissionProfile("changeset");
    check(!("administration" in changeset) && !("pull_requests" in changeset), "new privileged permissions leaked into ordinary repository mutation");
  });
  await test("Pages enablement and dispatch permission profiles are narrow and command-owned", async () => {
    check(JSON.stringify(permissionProfile("pages_ensure")) === JSON.stringify({ pages: "write", administration: "write" }), "Pages enablement scope changed");
    check(JSON.stringify(permissionProfile("pages_dispatch")) === JSON.stringify({ actions: "write" }), "Pages workflow dispatch scope changed");
    const changeset = permissionProfile("changeset");
    check(!("pages" in changeset) && !("administration" in changeset) && !("actions" in changeset), "Pages permissions leaked into ordinary repository mutation");
  });
  await test("classic protection permission profile is removed", async () => {
    let rejected = false;
    try { permissionProfile("review_protection"); } catch { rejected = true; }
    check(rejected, "classic protection permission profile still exists");
  });
  await test("unknown permission profiles are rejected", async () => {
    let rejected = false;
    try { permissionProfile("caller_supplied_admin"); } catch { rejected = true; }
    check(rejected, "arbitrary permission profile accepted");
  });
  await test("installation-wide token scope is reserved for repository template generation", async () => {
    const ordinary = installationTokenRequestBody("owner/repo", "changeset", "repository");
    check(JSON.stringify(ordinary) === JSON.stringify({ repositories: ["repo"], permissions: { contents: "write" } }), "ordinary repository token scope changed");
    const template = installationTokenRequestBody("owner/template", "repository_from_template", "installation");
    check(!Object.prototype.hasOwnProperty.call(template, "repositories"), "template generation token stayed narrowed to the source repository");
    check(JSON.stringify(template.permissions) === JSON.stringify({ administration: "write", contents: "read" }), "template generation installation-wide token changed permissions");
    let rejected = false;
    try { installationTokenRequestBody("owner/repo", "changeset", "installation"); } catch (error) { rejected = error?.code === "GITHUB_APP_INSTALLATION_WIDE_TOKEN_FORBIDDEN"; }
    check(rejected, "an unrelated command acquired installation-wide token scope");
  });
  await test("installation token is hidden from callback result", async () => {
    const auth = { token: "secret-token", installationId: 1 };
    const result = await withInstallationTokenClient(auth, async (client) => {
      check(!("token" in client), "token exposed on client");
      await client.call("github", { path: "/fixture" });
      return { ok: true };
    }, {
      rawRequest: async () => ({ status: 200, body: { ok: true } }),
      revokeRequest: async () => ({ status: 204 }),
    });
    check(JSON.stringify(result) === JSON.stringify({ ok: true }), "token leaked in callback result");
  });
  await test("installation token is revoked after use", async () => {
    const auth = { token: "secret-token", installationId: 1 };
    let revoked = false;
    await withInstallationTokenClient(auth, async () => ({ ok: true }), {
      rawRequest: async () => ({ status: 200, body: {} }),
      revokeRequest: async (path, options) => {
        revoked = path === "/installation/token" && options.method === "DELETE" && options.token === "secret-token";
        return { status: 204 };
      },
    });
    check(revoked, "token was not explicitly revoked");
  });
  await test("auth client does not log token material", async () => {
    const auth = { token: "secret-token", installationId: 1 };
    const captured = [];
    const original = console.log;
    console.log = (...args) => captured.push(args.join(" "));
    try {
      await withInstallationTokenClient(auth, async (client) => {
        await client.graphql("query { viewer { login } }");
        return { ok: true };
      }, {
        rawRequest: async () => ({ status: 200, body: { data: {} } }),
        revokeRequest: async () => ({ status: 204 }),
      });
    } finally {
      console.log = original;
    }
    check(!captured.join("\n").includes("secret-token"), "token appeared in logs");
  });

  await test("installation identity is cached without caching installation tokens", async () => {
    let lookups = 0;
    const resolver = createInstallationResolver({
      lookup: async () => { lookups += 1; return 42; },
      now: () => 1000,
      sleep: async () => {},
      cache: new Map(),
    });
    const first = await resolver.resolve("owner/repo", "jwt-1");
    const second = await resolver.resolve("owner/repo", "jwt-2");
    check(first === 42 && second === 42, "installation resolver returned the wrong id");
    check(lookups === 1, `installation id should be cached; observed ${lookups} lookups`);
  });

  await test("installation cache invalidation forces authoritative refresh", async () => {
    let lookups = 0;
    const resolver = createInstallationResolver({
      lookup: async () => { lookups += 1; return 40 + lookups; },
      now: () => 1000,
      sleep: async () => {},
      cache: new Map(),
    });
    const first = await resolver.resolve("owner/repo", "jwt-1");
    resolver.invalidate("owner/repo");
    const second = await resolver.resolve("owner/repo", "jwt-2");
    check(first === 41 && second === 42 && lookups === 2, "installation invalidation did not refresh identity");
  });

  await test("installation lookup retries bounded transient read failures", async () => {
    let lookups = 0;
    const resolver = createInstallationResolver({
      lookup: async () => {
        lookups += 1;
        if (lookups < 3) throw Object.assign(new Error("temporary"), { status: 503 });
        return 77;
      },
      now: () => 1000,
      sleep: async () => {},
      cache: new Map(),
    });
    const installationId = await resolver.resolve("owner/repo", "jwt");
    check(installationId === 77, "installation lookup did not recover");
    check(lookups === 3, `expected 3 bounded installation lookup attempts, observed ${lookups}`);
  });

  await test("auth upstream errors carry phase path request id retry evidence", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        status: 503,
        headers: new Headers({ "x-github-request-id": `AUTH-${calls}`, "retry-after": "1" }),
        async text() { return JSON.stringify({ message: "temporary auth failure" }); },
      };
    };
    let failure = null;
    try {
      await githubRequest("/repos/owner/repo/installation", {
        token: "jwt",
        phase: "auth.installation_lookup",
        retrySafeRead: true,
        sleep: async () => {},
        random: () => 0,
      });
    } catch (error) {
      failure = error;
    } finally {
      globalThis.fetch = originalFetch;
    }
    check(failure?.phase === "auth.installation_lookup", "auth error omitted phase");
    check(failure?.githubPath === "/repos/owner/repo/installation", "auth error omitted path");
    check(failure?.githubRequestId === "AUTH-3", "auth error omitted final GitHub request id");
    check(failure?.retryAfter === "1", "auth error omitted Retry-After");
    check(failure?.attempts === 3, "auth safe read did not report bounded attempts");
    check(calls === 3, `auth safe read expected 3 attempts, observed ${calls}`);
  });

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}
