import { config } from "hatchable";

const API_VERSION = "2026-03-10";
const USER_AGENT = "Hatchable-Portfolio-Control-Plane/1.0";

// Permission profiles are command-owned. Callers select only a fixed internal
// profile name; request input can never supply arbitrary GitHub App permissions.
const PERMISSION_PROFILES = Object.freeze({
  changeset: Object.freeze({ contents: "write" }),
  review_packet: Object.freeze({ contents: "read" }),
  review_pull_requests: Object.freeze({ pull_requests: "read" }),
  review_checks: Object.freeze({ checks: "read" }),
  review_statuses: Object.freeze({ statuses: "read" }),
  portfolio_reconcile: Object.freeze({
    metadata: "read",
    issues: "read",
  }),
  review_protection: Object.freeze({ administration: "read" }),
});

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
  const result = await githubRawRequest(path, options);
  if (result.status < 200 || result.status >= 300) {
    const message = typeof result.body === "object" && result.body?.message
      ? result.body.message
      : `GitHub returned HTTP ${result.status}`;
    throw Object.assign(new Error(message), {
      code: "GITHUB_APP_UPSTREAM_ERROR",
      status: result.status,
      githubPath: path,
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

async function createInstallationToken(repo, profileName) {
  const [owner, name] = repo.split("/");
  const permissions = permissionProfile(profileName);
  const appId = await config.get("GITHUB_APP_ID");
  const privateKeyValue = await config.get("GITHUB_APP_PRIVATE_KEY");
  const jwt = await createGitHubAppJwt({ appId, privateKeyValue });

  const installation = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    { token: jwt },
  );
  const installationId = installation.body?.id;
  if (!installationId) {
    throw Object.assign(new Error("GitHub did not return an installation id."), {
      code: "GITHUB_APP_INSTALLATION_NOT_FOUND",
    });
  }

  const tokenResponse = await githubRequest(`/app/installations/${installationId}/access_tokens`, {
    token: jwt,
    method: "POST",
    body: {
      repositories: [name],
      permissions,
    },
  });
  const token = tokenResponse.body?.token;
  if (!token) {
    throw Object.assign(new Error("GitHub did not return an installation access token."), {
      code: "GITHUB_APP_TOKEN_MISSING",
    });
  }
  return { token, installationId };
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
  const auth = await createInstallationToken(repo, profileName);
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
  await test("review permissions cannot leak into changeset profile", async () => {
    const changeset = permissionProfile("changeset");
    check(!("pull_requests" in changeset) && !("checks" in changeset) && !("statuses" in changeset) && !("administration" in changeset), "review permission leaked");
  });
  await test("review packet identity profile stays on already-granted contents read", async () => {
    check(JSON.stringify(permissionProfile("review_packet")) === JSON.stringify({ contents: "read" }), "review packet identity scope must use contents read");
  });
  await test("review observation permissions remain isolated", async () => {
    check(JSON.stringify(permissionProfile("review_pull_requests")) === JSON.stringify({ pull_requests: "read" }), "pull-request observation scope changed");
    check(JSON.stringify(permissionProfile("review_checks")) === JSON.stringify({ checks: "read" }), "checks scope changed");
    check(JSON.stringify(permissionProfile("review_statuses")) === JSON.stringify({ statuses: "read" }), "statuses scope changed");
    check(JSON.stringify(permissionProfile("review_protection")) === JSON.stringify({ administration: "read" }), "protection scope changed");
  });
  await test("unknown permission profiles are rejected", async () => {
    let rejected = false;
    try { permissionProfile("caller_supplied_admin"); } catch { rejected = true; }
    check(rejected, "arbitrary permission profile accepted");
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

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}