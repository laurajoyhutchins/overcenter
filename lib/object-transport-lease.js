import { createEncryptedGitHubInstallationLease, githubAppPermissionProfile, withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { recipientFingerprint, rsaOaepEncrypt } from 'lib/rsa-oaep.js';

const REPOSITORY = 'laurajoyhutchins/building-code-map';
const LEASE_BRANCH = 'object-transport-lease';
const LEASE_PATH = '.object-transport/lease.json';
const LABEL = 'bcm-object-transport-lease-v1';
const RECIPIENT = Object.freeze({
  kty: 'RSA',
  alg: 'RSA-OAEP-256',
  use: 'enc',
  n: 'zMK26kpVjq8TNO_qQFDT2cltatxnOjDC-KOTDTTnLSqxavnOU_qB2PZb9tXWKhsY_Dz5D--taqFNioMK4hRiLBNxf0IkjoTRFB5yePFOGDK6G4jmk-QmKpZm70eDSDwuAd2EWUiGFptdPNrd6k6frh-COE4CGnvS3i_luOU2Cvd3uNoDurdfX99SLCmcq0FX0kNe7S-EXtRJdhtTwNGOGpSidFKOpNlaKUfKgXJRM9NUAvZ6eAv6RNFnzwYxO8Gh0z0dwx4sQh1ArVHRew5L3XR4_SkKN744zFGnGWvraXmI67NtTtT33sCvw6-RwiNf395dOaVdDJ5c3rmiifcBvw',
  e: 'AQAB',
});

function requireSuccess(response, phase, expected = null) {
  const status = Number(response?.status || 0);
  if (expected ? expected.includes(status) : status < 200 || status >= 300) {
    const error = new Error(`GitHub ${phase} failed with HTTP ${status}: ${response?.body?.message || 'unknown error'}`);
    error.code = 'OBJECT_TRANSPORT_LEASE_GITHUB_ERROR';
    error.phase = phase;
    error.status = status;
    throw error;
  }
  return response;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function refreshObjectTransportLease() {
  const fingerprint = await recipientFingerprint(RECIPIENT);
  const encrypted = await createEncryptedGitHubInstallationLease(
    REPOSITORY,
    'changeset',
    async token => {
      const chunks = [];
      for (let offset = 0, index = 0; offset < token.length; offset += 160, index += 1) {
        chunks.push(await rsaOaepEncrypt(RECIPIENT, token.slice(offset, offset + 160), `${LABEL}:${index}`));
      }
      return JSON.stringify(chunks);
    },
  );
  if (!encrypted.expires_at) throw new Error('GitHub installation lease omitted expires_at');
  const expiresAt = Date.parse(encrypted.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 10 * 60 * 1000) {
    throw new Error('GitHub installation lease lifetime is too short');
  }
  const issuedAt = new Date().toISOString();
  const lease = {
    schema_version: '1.0',
    lease_schema: 'github-installation-token-lease-v1',
    repository: REPOSITORY,
    permissions: githubAppPermissionProfile('changeset'),
    recipient: { algorithm: 'RSA-OAEP-256', fingerprint_sha256: fingerprint, label: LABEL },
    ciphertext_format: 'rsa-oaep-chunks-v1',
    installation_id: encrypted.installation_id,
    issued_at: issuedAt,
    expires_at: encrypted.expires_at,
    ciphertext: encrypted.ciphertext,
  };
  const content = `${JSON.stringify(lease, null, 2)}\n`;
  const ciphertextSha256 = await sha256Hex(encrypted.ciphertext);

  const result = await withGitHubAppApiClient(REPOSITORY, async api => {
    const repoPath = '/repos/laurajoyhutchins/building-code-map';
    const mainRef = requireSuccess(await api.call('github', { path: `${repoPath}/git/ref/heads/main` }), 'read main ref');
    const mainSha = mainRef.body?.object?.sha;
    if (!/^[0-9a-f]{40}$/.test(String(mainSha || ''))) throw new Error('main ref omitted commit SHA');
    const commit = requireSuccess(await api.call('github', { path: `${repoPath}/git/commits/${mainSha}` }), 'read main commit');
    const baseTree = commit.body?.tree?.sha;
    if (!/^[0-9a-f]{40}$/.test(String(baseTree || ''))) throw new Error('main commit omitted tree SHA');
    const blob = requireSuccess(await api.call('github', { path: `${repoPath}/git/blobs`, method: 'POST', body: { content, encoding: 'utf-8' } }), 'create lease blob');
    const tree = requireSuccess(await api.call('github', { path: `${repoPath}/git/trees`, method: 'POST', body: { base_tree: baseTree, tree: [{ path: LEASE_PATH, mode: '100644', type: 'blob', sha: blob.body?.sha }] } }), 'create lease tree');
    const leaseCommit = requireSuccess(await api.call('github', { path: `${repoPath}/git/commits`, method: 'POST', body: { message: 'chore: refresh object transport lease', tree: tree.body?.sha, parents: [mainSha] } }), 'create lease commit');
    const newSha = leaseCommit.body?.sha;
    const existing = await api.call('github', { path: `${repoPath}/git/ref/heads/${LEASE_BRANCH}` });
    if (Number(existing?.status) === 404) {
      requireSuccess(await api.call('github', { path: `${repoPath}/git/refs`, method: 'POST', body: { ref: `refs/heads/${LEASE_BRANCH}`, sha: newSha } }), 'create lease ref');
    } else {
      requireSuccess(existing, 'read lease ref');
      requireSuccess(await api.call('github', { path: `${repoPath}/git/refs/heads/${LEASE_BRANCH}`, method: 'PATCH', body: { sha: newSha, force: true } }), 'refresh lease ref');
    }
    const verified = requireSuccess(await api.call('github', { path: `${repoPath}/git/ref/heads/${LEASE_BRANCH}` }), 'verify lease ref');
    if (verified.body?.object?.sha !== newSha) throw new Error('lease ref verification mismatch');
    return { commit_sha: newSha, base_sha: mainSha };
  }, { permissionProfile: 'changeset' });

  return {
    ok: true,
    schema: 'github-installation-token-lease-v1',
    repository: REPOSITORY,
    branch: LEASE_BRANCH,
    path: LEASE_PATH,
    recipient_fingerprint_sha256: fingerprint,
    issued_at: issuedAt,
    expires_at: encrypted.expires_at,
    ciphertext_sha256: ciphertextSha256,
    commit_sha: result.commit_sha,
    base_sha: result.base_sha,
  };
}