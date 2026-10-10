import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalDigest, sha256 } from '../../digest.ts';
import { assertExactKeys, isData, isPositiveSafeInteger, isSha256Hex } from '../../validation.ts';

export interface PagesLimits {
  max_files: number;
  max_total_bytes: number;
  max_observation_calls: number;
}
export interface PagesManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
  delivery: 'served' | 'metadata';
}
export interface PagesManifest {
  files: PagesManifestEntry[];
  file_count: number;
  total_bytes: number;
  sha256: string;
}
export interface PagesPublication {
  provider: 'github';
  repository_id: number;
  repository_full_name: string;
  source_sha: string;
  source_tree_sha: string;
  source_ref: string;
  destination_ref: string;
  expected_head_sha: string | null;
  publication_sha: string;
  publication_tree_sha: string;
  site_base_url: string;
  pages_source_path: '/';
  manifest: PagesManifest;
  limits: PagesLimits;
}
export interface GitHubPagesPublicationPostcondition extends PagesPublication {
  verifier: 'github-pages-static-tree-published/v1';
}

function fail(): never {
  throw new Error('PAGES_PUBLICATION_INVALID');
}
const sha40 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
export function validPagesPath(path: string): boolean {
  return (
    path === '.nojekyll' ||
    (path.length <= 4096 &&
      path.split('/').length <= 32 &&
      path
        .split('/')
        .every(
          (part) =>
            part.length <= 255 &&
            /^[a-z0-9][a-z0-9._-]*$/.test(part) &&
            !part.includes('..') &&
            !part.endsWith('.'),
        ))
  );
}
export function validatePagesLimits(limits: unknown): asserts limits is PagesLimits {
  if (!isData(limits)) fail();
  assertExactKeys(
    limits,
    ['max_files', 'max_total_bytes', 'max_observation_calls'],
    [],
    'PAGES_LIMITS_INVALID',
  );
  if (!Object.values(limits).every(isPositiveSafeInteger)) fail();
}
export function validatePagesManifest(
  value: unknown,
  limits: PagesLimits,
): asserts value is PagesManifest {
  validatePagesLimits(limits);
  if (!isData(value)) fail();
  assertExactKeys(
    value,
    ['files', 'file_count', 'total_bytes', 'sha256'],
    [],
    'PAGES_MANIFEST_INVALID',
  );
  if (
    !Array.isArray(value.files) ||
    value.files.length > limits.max_files ||
    !isSha256Hex(value.sha256)
  )
    fail();
  let total = 0;
  let previous = '';
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!isData(file)) fail();
    assertExactKeys(file, ['path', 'bytes', 'sha256', 'delivery'], [], 'PAGES_FILE_INVALID');
    if (
      typeof file.path !== 'string' ||
      !validPagesPath(file.path) ||
      file.path <= previous ||
      !isSha256Hex(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      Number(file.bytes) < 0 ||
      file.delivery !== (file.path === '.nojekyll' ? 'metadata' : 'served')
    )
      fail();
    if (file.path === '.nojekyll' && (file.bytes !== 0 || file.sha256 !== sha256(''))) fail();
    previous = file.path;
    paths.add(file.path);
    total += Number(file.bytes);
    if (!Number.isSafeInteger(total) || total > limits.max_total_bytes) fail();
  }
  if (
    !paths.has('index.html') ||
    !paths.has('.nojekyll') ||
    value.file_count !== paths.size ||
    value.total_bytes !== total ||
    value.sha256 !==
      canonicalDigest({ files: value.files, file_count: paths.size, total_bytes: total })
  )
    fail();
  for (const path of paths) {
    const parts = path.split('/');
    for (let count = 1; count < parts.length; count++)
      if (paths.has(parts.slice(0, count).join('/'))) fail();
  }
}

export function validatePagesPublication(value: unknown): asserts value is PagesPublication {
  if (!isData(value)) fail();
  assertExactKeys(
    value,
    [
      'provider',
      'repository_id',
      'repository_full_name',
      'source_sha',
      'source_tree_sha',
      'source_ref',
      'destination_ref',
      'expected_head_sha',
      'publication_sha',
      'publication_tree_sha',
      'site_base_url',
      'pages_source_path',
      'manifest',
      'limits',
    ],
    ['verifier'],
    'PAGES_PUBLICATION_INVALID',
  );
  if (
    value.provider !== 'github' ||
    !isPositiveSafeInteger(value.repository_id) ||
    typeof value.repository_full_name !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository_full_name) ||
    !['source_sha', 'source_tree_sha', 'publication_sha', 'publication_tree_sha'].every((key) =>
      sha40(value[key]),
    ) ||
    (value.expected_head_sha !== null && !sha40(value.expected_head_sha)) ||
    value.pages_source_path !== '/' ||
    value.destination_ref !== 'refs/heads/gh-pages' ||
    typeof value.source_ref !== 'string' ||
    !/^refs\/heads\/[A-Za-z0-9/_-]+$/.test(value.source_ref) ||
    value.source_ref === value.destination_ref ||
    (value.verifier !== undefined && value.verifier !== 'github-pages-static-tree-published/v1')
  )
    fail();
  if (typeof value.site_base_url !== 'string') fail();
  const url = new URL(value.site_base_url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    url.href !== value.site_base_url ||
    !url.pathname.endsWith('/') ||
    !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(url.pathname)
  )
    fail();
  validatePagesLimits(value.limits);
  validatePagesManifest(value.manifest, value.limits);
}

export async function manifestStaticTree(
  root: string,
  limits: PagesLimits,
): Promise<PagesManifest> {
  validatePagesLimits(limits);
  if (!(await lstat(root)).isDirectory()) fail();
  const files: PagesManifestEntry[] = [];
  let total = 0;
  let visited = 0;
  // At most 32 path components per file, plus the files themselves. Empty
  // directories consume this same budget. Stream directory entries, not arrays.
  const maxEntries = Math.min(Number.MAX_SAFE_INTEGER, limits.max_files * 33);
  const walk = async (relative: string): Promise<void> => {
    const directory = await opendir(join(root, relative));
    for await (const entry of directory) {
      if (++visited > maxEntries) fail();
      const name = entry.name;
      const path = relative ? `${relative}/${name}` : name;
      if (!validPagesPath(path)) fail();
      const disk = join(root, path);
      const stat = await lstat(disk);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) {
        await walk(path);
        continue;
      }
      if (
        !stat.isFile() ||
        (stat.mode & 0o111) !== 0 ||
        files.length >= limits.max_files ||
        stat.size > limits.max_total_bytes - total
      )
        fail();
      const fd = await open(disk, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const pinned = await fd.stat();
        if (
          !pinned.isFile() ||
          pinned.ino !== stat.ino ||
          pinned.dev !== stat.dev ||
          pinned.size !== stat.size
        )
          fail();
        const content = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < content.length) {
          const { bytesRead } = await fd.read(content, offset, content.length - offset, offset);
          if (!bytesRead) fail();
          offset += bytesRead;
        }
        const after = await fd.stat();
        if (
          after.size !== pinned.size ||
          after.mtimeMs !== pinned.mtimeMs ||
          after.ctimeMs !== pinned.ctimeMs
        )
          fail();
        files.push({
          path,
          bytes: content.length,
          sha256: sha256(content),
          delivery: path === '.nojekyll' ? 'metadata' : 'served',
        });
        total += content.length;
      } finally {
        await fd.close();
      }
    }
  };
  await walk('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = { files, file_count: files.length, total_bytes: total };
  const manifest = { ...body, sha256: canonicalDigest(body) };
  validatePagesManifest(manifest, limits);
  return manifest;
}
