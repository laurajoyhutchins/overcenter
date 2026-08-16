import { config } from "hatchable";

const API_VERSION = "2026-03-10";
const USER_AGENT = "Hatchable-Portfolio-Control-Plane/1.0";
const SHA256_DIGEST_INFO_PREFIX = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03,
  0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20
]);

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, a) => sum + a.length, 0);
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

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function utf8Base64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function pemBodyToBytes(pem, label) {
  const normalized = String(pem || "").trim();
  const start = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  if (!normalized.includes(start) || !normalized.includes(end)) return null;
  const body = normalized.slice(normalized.indexOf(start) + start.length, normalized.indexOf(end))
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
    if (count === 0 || count > 4 || offset + count > bytes.length) throw new Error("Invalid DER length.");
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[offset++];
  }
  const start = offset;
  const end = start + length;
  if (end > bytes.length) throw new Error("DER length exceeds input.");
  return { tag, start, end, next: end, content: bytes.subarray(start, end) };
}

function extractPkcs1(privateKeyPem) {
  const pkcs1 = pemBodyToBytes(privateKeyPem, "RSA PRIVATE KEY");
  if (pkcs1) return pkcs1;

  const pkcs8 = pemBodyToBytes(privateKeyPem, "PRIVATE KEY");
  if (!pkcs8) throw new Error("Private key must be PEM PKCS#1 or PKCS#8 RSA.");

  const root = readDer(pkcs8, 0, 0x30);
  let offset = root.start;
  const version = readDer(pkcs8, offset, 0x02); offset = version.next;
  const algorithm = readDer(pkcs8, offset, 0x30); offset = algorithm.next;
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

function parseRsaPrivateKey(privateKeyPem) {
  try {
    const pkcs1 = extractPkcs1(privateKeyPem);
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
    const exponentBytes = unsignedIntegerBytes(fields[2]);
    const privateExponentBytes = unsignedIntegerBytes(fields[3]);
    return {
      n: bytesToBigInt(modulusBytes),
      e: bytesToBigInt(exponentBytes),
      d: bytesToBigInt(privateExponentBytes),
      modulusLength: modulusBytes.length
    };
  } catch (error) {
    throw Object.assign(new Error(`Unable to parse GitHub App RSA private key: ${error.message}`), {
      code: "INVALID_GITHUB_APP_PRIVATE_KEY"
    });
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
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(signingInput)
  ));
  const digestInfo = concatBytes(SHA256_DIGEST_INFO_PREFIX, digest);
  const paddingLength = modulusLength - digestInfo.length - 3;
  if (paddingLength < 8) throw new Error("RSA modulus is too short for RS256.");
  const padding = new Uint8Array(paddingLength);
  padding.fill(0xff);
  return concatBytes(Uint8Array.of(0x00, 0x01), padding, Uint8Array.of(0x00), digestInfo);
}

async function signRs256(signingInput, privateKeyPem) {
  const key = parseRsaPrivateKey(privateKeyPem);
  const em = await encodedMessage(signingInput, key.modulusLength);
  const m = bytesToBigInt(em);
  if (m >= key.n) throw new Error("Encoded message exceeds RSA modulus.");
  const signature = modPow(m, key.d, key.n);
  return bigIntToBytes(signature, key.modulusLength);
}

export async function createGitHubAppJwt({ appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const iss = String(appId || "").trim();
  if (!/^\d+$/.test(iss)) {
    throw Object.assign(new Error("GITHUB_APP_ID must be the numeric GitHub App ID."), {
      code: "INVALID_GITHUB_APP_ID"
    });
  }
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss };
  const signingInput = `${utf8Base64Url(JSON.stringify(header))}.${utf8Base64Url(JSON.stringify(payload))}`;
  const signature = await signRs256(signingInput, privateKeyPem);
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

export async function verifyGitHubAppJwtSelfTest(jwt, privateKeyPem) {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) return false;
  const key = parseRsaPrivateKey(privateKeyPem);
  const signature = base64UrlToBytes(parts[2]);
  if (signature.length !== key.modulusLength) return false;
  const recovered = bigIntToBytes(modPow(bytesToBigInt(signature), key.e, key.n), key.modulusLength);
  const expected = await encodedMessage(`${parts[0]}.${parts[1]}`, key.modulusLength);
  if (recovered.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < recovered.length; i++) diff |= recovered[i] ^ expected[i];
  return diff === 0;
}

async function githubRequest(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed?.message ? parsed.message : `GitHub returned HTTP ${response.status}`;
    throw Object.assign(new Error(message), {
      code: "GITHUB_APP_POC_UPSTREAM_ERROR",
      status: response.status
    });
  }
  return { status: response.status, body: parsed };
}

function validateRepo(repo) {
  const value = String(repo || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw Object.assign(new Error("repo must be in owner/name form."), { code: "INVALID_REPO" });
  }
  return value;
}

export async function probeGitHubAppRepository(repoInput) {
  const repo = validateRepo(repoInput);
  const [owner, name] = repo.split("/");
  const appId = await config.get("GITHUB_APP_ID");
  const privateKeyPem = await config.get("GITHUB_APP_PRIVATE_KEY");
  const jwt = await createGitHubAppJwt({ appId, privateKeyPem });

  const installation = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    { token: jwt }
  );
  const installationId = installation.body?.id;
  if (!installationId) throw Object.assign(new Error("GitHub did not return an installation id."), { code: "GITHUB_APP_INSTALLATION_NOT_FOUND" });

  const tokenResponse = await githubRequest(`/app/installations/${installationId}/access_tokens`, {
    token: jwt,
    method: "POST",
    body: { repositories: [name], permissions: { contents: "write" } }
  });
  const installationToken = tokenResponse.body?.token;
  if (!installationToken) throw Object.assign(new Error("GitHub did not return an installation access token."), { code: "GITHUB_APP_TOKEN_MISSING" });

  let result;
  let revoked = false;
  try {
    const repoResponse = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      { token: installationToken }
    );
    const defaultBranch = repoResponse.body?.default_branch;
    if (!defaultBranch) throw Object.assign(new Error("Repository response did not include default_branch."), { code: "GITHUB_APP_REPO_PROBE_INVALID" });
    const refResponse = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      { token: installationToken }
    );
    result = {
      ok: true,
      auth_model: "github_app_installation",
      app_id: String(appId),
      installation_id: installationId,
      installation_account: installation.body?.account?.login || null,
      repository: repoResponse.body?.full_name || repo,
      default_branch: defaultBranch,
      head_sha: refResponse.body?.object?.sha || null,
      granted_permissions: tokenResponse.body?.permissions || null,
      repository_scope: Array.isArray(tokenResponse.body?.repositories)
        ? tokenResponse.body.repositories.map(r => r.full_name || r.name)
        : [repo],
      token_expires_at: tokenResponse.body?.expires_at || null,
      token_persisted: false
    };
  } finally {
    try {
      await githubRequest("/installation/token", { token: installationToken, method: "DELETE" });
      revoked = true;
    } catch {
      revoked = false;
    }
  }
  return { ...result, token_revoked: revoked };
}

export const probeGitHubAppRepositoryWithRevocation = probeGitHubAppRepository;