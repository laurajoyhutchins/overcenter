import { createHash, createSign } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

interface GitHubTreeEntry {
  path?: unknown;
  mode?: unknown;
  type?: unknown;
  sha?: unknown;
}

interface ManifestEntry {
  path: string;
  mode: '100644' | '100755';
  blob_sha: string;
  sha256: string;
  size: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label}_INVALID`);
  return Number(value);
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
    '.' +
    base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return unsigned + '.' + signer.sign(privateKey).toString('base64url');
}

const API_VERSION = '2026-03-10';

async function githubJson(
  endpoint: string,
  token: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.github.com' + endpoint, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'overcenter-gcp-direct-tree-materializer',
      'X-GitHub-Api-Version': API_VERSION,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GITHUB_API_${response.status}:${endpoint}:${text.slice(0, 400)}`);
  }
  const value: unknown = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GITHUB_API_INVALID_JSON:${endpoint}`);
  }
  return value as Record<string, unknown>;
}

function safePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')) {
    throw new Error('GITHUB_TREE_PATH_INVALID');
  }
  if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('GITHUB_TREE_PATH_CONTROL_CHARACTER');
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('GITHUB_TREE_PATH_TRAVERSAL');
  }
  return value;
}

function requiredSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value;
}

function gitBlobSha(data: Buffer): string {
  const header = Buffer.from(`blob ${data.length}\0`);
  return createHash('sha1').update(header).update(data).digest('hex');
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function main(): Promise<void> {
  const repository = requiredEnv('TARGET_REPOSITORY');
  const revision = requiredEnv('TARGET_REVISION');
  const repositoryId = positiveInteger(requiredEnv('TARGET_REPOSITORY_ID'), 'TARGET_REPOSITORY_ID');
  const ownerId = positiveInteger(requiredEnv('TARGET_OWNER_ID'), 'TARGET_OWNER_ID');
  const appId = requiredEnv('GITHUB_APP_ID');
  const privateKey = requiredEnv('GITHUB_APP_PRIVATE_KEY');

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('TARGET_REPOSITORY_INVALID');
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('TARGET_REVISION_INVALID');

  const jwt = appJwt(appId, privateKey);
  const installation = await githubJson(`/repos/${repository}/installation`, jwt);
  const installationId = positiveInteger(String(installation.id ?? ''), 'INSTALLATION_ID');
  const permissions =
    installation.permissions && typeof installation.permissions === 'object'
      ? (installation.permissions as Record<string, unknown>)
      : {};
  if (!['read', 'write'].includes(String(permissions.contents ?? ''))) {
    throw new Error('GITHUB_APP_CONTENTS_READ_REQUIRED');
  }

  const access = await githubJson(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    {
      method: 'POST',
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: { contents: 'read' },
      }),
    },
  );
  const token = requiredEnvValue(access.token, 'INSTALLATION_TOKEN');

  const identity = await githubJson(`/repos/${repository}`, token);
  if (
    Number(identity.id) !== repositoryId ||
    Number((identity.owner as Record<string, unknown> | undefined)?.id) !== ownerId ||
    String(identity.full_name ?? '').toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
  }

  const commit = await githubJson(`/repos/${repository}/git/commits/${revision}`, token);
  if (requiredSha(commit.sha, 'COMMIT_SHA') !== revision) {
    throw new Error('GITHUB_COMMIT_REVISION_MISMATCH');
  }
  const treeObject =
    commit.tree && typeof commit.tree === 'object'
      ? (commit.tree as Record<string, unknown>)
      : {};
  const treeSha = requiredSha(treeObject.sha, 'TREE_SHA');

  const tree = await githubJson(
    `/repos/${repository}/git/trees/${treeSha}?recursive=1`,
    token,
  );
  if (tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error('GITHUB_TREE_INCOMPLETE');
  }

  const root = resolve('/workspace/candidate-source');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const blobEntries = (tree.tree as GitHubTreeEntry[])
    .filter((entry) => entry.type !== 'tree')
    .map((entry) => {
      if (entry.type !== 'blob') throw new Error('GITHUB_TREE_UNSUPPORTED_ENTRY_TYPE');
      const path = safePath(entry.path);
      const mode = String(entry.mode ?? '');
      if (mode !== '100644' && mode !== '100755') {
        throw new Error(`GITHUB_TREE_UNSUPPORTED_MODE:${path}:${mode}`);
      }
      return {
        path,
        mode: mode as '100644' | '100755',
        sha: requiredSha(entry.sha, 'BLOB_SHA'),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const manifestEntries: ManifestEntry[] = [];
  const concurrency = 12;
  for (let offset = 0; offset < blobEntries.length; offset += concurrency) {
    const batch = blobEntries.slice(offset, offset + concurrency);
    const realized = await Promise.all(
      batch.map(async (entry): Promise<ManifestEntry> => {
        const blob = await githubJson(
          `/repos/${repository}/git/blobs/${entry.sha}`,
          token,
        );
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
          throw new Error(`GITHUB_BLOB_ENCODING_INVALID:${entry.path}`);
        }
        const data = Buffer.from(blob.content.replace(/\n/g, ''), 'base64');
        if (gitBlobSha(data) !== entry.sha) {
          throw new Error(`GITHUB_BLOB_DIGEST_MISMATCH:${entry.path}`);
        }

        const destination = resolve(root, entry.path);
        if (destination !== root && !destination.startsWith(root + sep)) {
          throw new Error(`GITHUB_TREE_PATH_ESCAPE:${entry.path}`);
        }
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, data, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
        chmodSync(destination, entry.mode === '100755' ? 0o755 : 0o644);
        return {
          path: entry.path,
          mode: entry.mode,
          blob_sha: entry.sha,
          sha256: sha256(data),
          size: data.length,
        };
      }),
    );
    manifestEntries.push(...realized);
  }

  const manifest = {
    schema: 'overcenter-github-tree-materialization/v1',
    repository,
    repository_id: repositoryId,
    owner_id: ownerId,
    revision,
    tree_sha: treeSha,
    entries: manifestEntries,
  };
  writeFileSync(
    resolve(root, '.overcenter-source-manifest.json'),
    JSON.stringify(manifest) + '\n',
    { mode: 0o444 },
  );

  process.stdout.write(
    JSON.stringify({
      event: 'github_tree_materialized',
      repository,
      revision,
      tree_sha: treeSha,
      blobs: manifestEntries.length,
    }) + '\n',
  );
}

function requiredEnvValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}_REQUIRED`);
  return value;
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exit(1);
});
