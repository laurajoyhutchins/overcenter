#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRIVATE_SOURCE_MANIFEST_SCHEMA = 'private-source-capsule/manifest/v1' as const;

export interface PrivateSourceEntry {
  path: string;
  mode: '100644' | '100755';
  blob_sha: string;
  size: number;
  sha256: string;
}

export interface PrivateSourceManifest {
  schema: typeof PRIVATE_SOURCE_MANIFEST_SCHEMA;
  repository: string;
  revision: string;
  tree_sha: string;
  entries: PrivateSourceEntry[];
}

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hex = (v: unknown, n: number): v is string =>
  typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);

function exactKeys(v: JsonObject, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...expected].sort());
}

function safeRepository(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) && !v.includes('..');
}

function safePath(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    !v.startsWith('/') &&
    !v.includes('\\') &&
    ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    v.split('/').every((p) => p && p !== '.' && p !== '..' && p !== '.git')
  );
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

export function gitBlobSha(b: Buffer): string {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]))
    .digest('hex');
}

export function validatePrivateSourceManifest(value: unknown): PrivateSourceManifest {
  if (
    !isObject(value) ||
    !exactKeys(value, ['schema', 'repository', 'revision', 'tree_sha', 'entries'])
  )
    throw new Error('PRIVATE_SOURCE_MANIFEST_INVALID');

  if (
    value.schema !== PRIVATE_SOURCE_MANIFEST_SCHEMA ||
    !safeRepository(value.repository) ||
    !hex(value.revision, 40) ||
    !hex(value.tree_sha, 40) ||
    !Array.isArray(value.entries)
  )
    throw new Error('PRIVATE_SOURCE_MANIFEST_INVALID');

  const entries: PrivateSourceEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.entries) {
    if (
      !isObject(raw) ||
      !exactKeys(raw, ['path', 'mode', 'blob_sha', 'size', 'sha256']) ||
      !safePath(raw.path) ||
      (raw.mode !== '100644' && raw.mode !== '100755') ||
      !hex(raw.blob_sha, 40) ||
      !Number.isSafeInteger(raw.size) ||
      (raw.size as number) < 0 ||
      !hex(raw.sha256, 64) ||
      seen.has(raw.path as string)
    )
      throw new Error('PRIVATE_SOURCE_ENTRY_INVALID');

    seen.add(raw.path as string);
    entries.push({
      path: raw.path as string,
      mode: raw.mode,
      blob_sha: raw.blob_sha as string,
      size: raw.size as number,
      sha256: raw.sha256 as string,
    });
  }

  if (!entries.length) throw new Error('PRIVATE_SOURCE_ENTRIES_EMPTY');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema: PRIVATE_SOURCE_MANIFEST_SCHEMA,
    repository: value.repository,
    revision: value.revision,
    tree_sha: value.tree_sha,
    entries,
  };
}

function gitTreeSha(entries: PrivateSourceEntry[]): string {
  type Node = { files: PrivateSourceEntry[]; dirs: Map<string, Node> };
  const root: Node = { files: [], dirs: new Map() };

  for (const e of entries) {
    const parts = e.path.split('/');
    const name = parts.pop() as string;
    let node = root;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ ...e, path: name });
  }

  const encode = (node: Node): Buffer => {
    const items: Array<{ name: string; mode: string; sha: string }> = [];
    for (const f of node.files) items.push({ name: f.path, mode: f.mode, sha: f.blob_sha });
    for (const [name, child] of node.dirs)
      items.push({
        name,
        mode: '40000',
        sha: createHash('sha1').update(encode(child)).digest('hex'),
      });

    items.sort((a, b) =>
      Buffer.from(a.name + (a.mode === '40000' ? '/' : '')).compare(
        Buffer.from(b.name + (b.mode === '40000' ? '/' : '')),
      ),
    );

    const body = Buffer.concat(
      items.map((i) =>
        Buffer.concat([Buffer.from(`${i.mode} ${i.name}\0`), Buffer.from(i.sha, 'hex')]),
      ),
    );
    return Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]);
  };

  return createHash('sha1').update(encode(root)).digest('hex');
}

export function verifyPrivateSourceCapsule(
  manifestValue: unknown,
  cacheRoot: string,
): PrivateSourceManifest {
  const manifest = validatePrivateSourceManifest(manifestValue);
  for (const e of manifest.entries) {
    const p = join(cacheRoot, e.blob_sha);
    const st = lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('PRIVATE_SOURCE_BLOB_SHAPE_INVALID');

    const b = readFileSync(p);
    if (b.length !== e.size || sha256(b) !== e.sha256 || gitBlobSha(b) !== e.blob_sha)
      throw new Error('PRIVATE_SOURCE_BLOB_MISMATCH');
  }

  if (gitTreeSha(manifest.entries) !== manifest.tree_sha)
    throw new Error('PRIVATE_SOURCE_TREE_MISMATCH');
  return manifest;
}

export function materializePrivateSource(
  manifestValue: unknown,
  cacheRoot: string,
  destination: string,
): void {
  const manifest = verifyPrivateSourceCapsule(manifestValue, cacheRoot);
  const temp = `${destination}.tmp-${process.pid}`;
  const previous = `${destination}.previous-${process.pid}`;

  rmSync(temp, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });

  try {
    for (const e of manifest.entries) {
      const out = join(temp, e.path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, readFileSync(join(cacheRoot, e.blob_sha)));
      chmodSync(out, e.mode === '100755' ? 0o755 : 0o644);
    }

    let hadDestination = false;
    try {
      lstatSync(destination);
      hadDestination = true;
    } catch {}

    if (hadDestination) renameSync(destination, previous);
    try {
      renameSync(temp, destination);
    } catch (error) {
      if (hadDestination) renameSync(previous, destination);
      throw error;
    }

    if (hadDestination) {
      try {
        rmSync(previous, { recursive: true, force: true });
      } catch {}
    }
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function main(args: string[]): void {
  const [cmd, manifestPath, cache, destination] = args;
  if (!manifestPath || !cache)
    throw new Error(
      'usage: private-source-capsule.ts verify <manifest.json> <blob-cache> | materialize <manifest.json> <blob-cache> <destination>',
    );

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (cmd === 'verify') {
    verifyPrivateSourceCapsule(manifest, cache);
    return;
  }
  if (cmd === 'materialize' && destination) {
    materializePrivateSource(manifest, cache, destination);
    return;
  }
  throw new Error('invalid private-source-capsule command');
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main(process.argv.slice(2));
}
