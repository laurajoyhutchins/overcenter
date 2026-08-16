import { config } from "hatchable";

const API_VERSION = "2026-03-10";
const USER_AGENT = "Hatchable-Portfolio-Control-Plane/1.0";

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
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
  const body = normalized.slice(normalized.indexOf(start) + start.length, normalized.indexOf(end))
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const parts = [];
  let value = length;
  while (value > 0) {
    parts.unshift(value & 0xff);
    value >>>= 8;
  }
  return Uint8Array.of(0x80 | parts.length, ...parts);
}

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

function der(tag, content) {
  return concatBytes(Uint8Array.of(tag), derLength(content.length), content);
}

function pkcs1ToPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryptionOid = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00
  );
  const privateKey = der(0x04, pkcs1);
  return der(0x30, concatBytes(version, rsaEncryptionOid, privateKey));
}

export async function importGitHubAppPrivateKey(privateKeyPem) {
  let bytes = pemBodyToBytes(privateKeyPem, "PRIVATE KEY");
  if (!bytes) {
    const pkcs1 = pemBodyToBytes(privateKeyPem, "RSA PRIVATE KEY");
    if (!pkcs1) {
      throw Object.assign(new Error("GitHub App private key must be PEM PKCS#8 or PKCS#1 RSA."), {
        code: "INVALID_GITHUB_APP_PRIVATE_KEY"
      });
    }
    bytes = pkcs1ToPkcs8(pkcs1);
  }

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch (error) {
    throw Object.assign(new Error(`Unable to import GitHub App private key: ${error.message}`), {
      code: "INVALID_GITHUB_APP_PRIVATE_KEY"
    });
  }
}

export async function createGitHubAppJwt({ appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const iss = String(appId || "").trim();
  if (!/^\d+$/.test(iss)) {
    throw Object.assign(new Error("GITHUB_APP_ID must be the numeric GitHub App ID."), {
      code: "INVALID_GITHUB_APP_ID"
    });
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss
  };
  const signingInput = `${utf8Base64Url(JSON.stringify(header))}.${utf8Base64Url(JSON.stringify(payload))}`;
  const key = await importGitHubAppPrivateKey(privateKeyPem);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput)
  ));
  return `${signingInput}.${bytesToBase64Url(signature)}`;
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
      status: response.status,
      github: parsed
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
  if (!installationId) {
    throw Object.assign(new Error("GitHub did not return an installation id for this repository."), {
      code: "GITHUB_APP_INSTALLATION_NOT_FOUND"
    });
  }

  const tokenResponse = await githubRequest(`/app/installations/${installationId}/access_tokens`, {
    token: jwt,
    method: "POST",
    body: {
      repositories: [name],
      permissions: { contents: "write" }
    }
  });

  const installationToken = tokenResponse.body?.token;
  if (!installationToken) {
    throw Object.assign(new Error("GitHub did not return an installation access token."), {
      code: "GITHUB_APP_TOKEN_MISSING"
    });
  }

  let result;
  let revoked = false;
  try {
    const repoResponse = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      { token: installationToken }
    );
    const defaultBranch = repoResponse.body?.default_branch;
    if (!defaultBranch) {
      throw Object.assign(new Error("Repository response did not include default_branch."), {
        code: "GITHUB_APP_REPO_PROBE_INVALID"
      });
    }

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