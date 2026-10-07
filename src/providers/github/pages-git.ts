import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalDigest, sha256 } from '../../digest.ts';
import { validatePagesManifest, type PagesLimits, type PagesManifest } from './pages-contract.ts';

export function pagesGit(
  repo: string,
  args: string[],
  input?: string | Uint8Array,
  extraEnv: Record<string, string> = {},
): Buffer {
  return execFileSync(
    'git',
    ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
    {
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...extraEnv,
      },
    },
  );
}
export function pagesGitText(repo: string, args: string[]): string {
  return pagesGit(repo, args).toString('utf8').trim();
}
function entries(repo: string, tree: string): { mode: string; oid: string; path: string }[] {
  return pagesGit(repo, ['ls-tree', '-rz', tree])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(row);
      if (!match) throw new Error('PAGES_GIT_NONREGULAR_ENTRY');
      const [, mode, oid, path] = match;
      if (
        !mode ||
        !oid ||
        !path ||
        !['100644', '100755'].includes(mode) ||
        path.includes('\\') ||
        path.split('/').some((part) => !part || ['.', '..', '.git'].includes(part))
      ) {
        throw new Error('PAGES_GIT_UNSAFE_ENTRY');
      }
      return { mode, oid, path };
    });
}
export async function copyPagesSource(
  repo: string,
  sourceSha: string,
  workspace: string,
): Promise<void> {
  for (const entry of entries(repo, sourceSha)) {
    const path = join(workspace, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, pagesGit(repo, ['cat-file', 'blob', entry.oid]), {
      flag: 'wx',
      mode: entry.mode === '100755' ? 0o755 : 0o644,
    });
  }
}
export function readPagesGitManifest(
  repo: string,
  tree: string,
  limits: PagesLimits,
): PagesManifest {
  const rows = entries(repo, tree);
  if (rows.length > limits.max_files) throw new Error('PAGES_GIT_FILE_BUDGET');
  let total = 0;
  const files = rows
    .map((entry) => {
      if (entry.mode !== '100644') throw new Error('PAGES_GIT_EXECUTABLE');
      const size = Number(pagesGitText(repo, ['cat-file', '-s', entry.oid]));
      if (!Number.isSafeInteger(size) || size < 0 || size > limits.max_total_bytes - total)
        throw new Error('PAGES_GIT_BYTE_BUDGET');
      const content = pagesGit(repo, ['cat-file', 'blob', entry.oid]);
      if (content.length !== size) throw new Error('PAGES_GIT_BLOB_CHANGED');
      total += size;
      return {
        path: entry.path,
        bytes: size,
        sha256: sha256(content),
        delivery: entry.path === '.nojekyll' ? ('metadata' as const) : ('served' as const),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = { files, file_count: files.length, total_bytes: total };
  const manifest = { ...body, sha256: canonicalDigest(body) };
  validatePagesManifest(manifest, limits);
  return manifest;
}
export async function writePagesGitTree(
  repo: string,
  root: string,
  manifest: PagesManifest,
  indexPath: string,
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexPath };
  pagesGit(repo, ['read-tree', '--empty'], undefined, env);
  for (const file of manifest.files) {
    const content = await readFile(join(root, file.path));
    if (content.length !== file.bytes || sha256(content) !== file.sha256)
      throw new Error('PAGES_OUTPUT_MOVED');
    const oid = pagesGit(repo, ['hash-object', '-w', '--stdin'], content).toString('utf8').trim();
    pagesGit(
      repo,
      ['update-index', '--add', '--cacheinfo', '100644', oid, file.path],
      undefined,
      env,
    );
  }
  return pagesGit(repo, ['write-tree'], undefined, env).toString('utf8').trim();
}
