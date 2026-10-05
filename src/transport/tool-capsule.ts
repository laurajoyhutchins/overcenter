#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOOL_CAPSULE_REQUEST_SCHEMA = 'tool-capsule/request/v1' as const;
export const TOOL_CAPSULE_MANIFEST_SCHEMA = 'tool-capsule/manifest/v1' as const;
export const TOOL_CAPSULE_PLATFORM = 'linux-x86-64' as const;

export interface ToolCapsulePackage {
  name: string;
  version: string;
  hashes: string[];
}

export interface ToolCapsuleRequest {
  schema: typeof TOOL_CAPSULE_REQUEST_SCHEMA;
  source: {
    repository: string;
    revision: string;
    lock_blob_sha: string;
  };
  target: {
    python_version: string;
    platform: typeof TOOL_CAPSULE_PLATFORM;
  };
  packages: ToolCapsulePackage[];
}

export interface ToolCapsuleManifest {
  schema: typeof TOOL_CAPSULE_MANIFEST_SCHEMA;
  request_sha256: string;
  source: ToolCapsuleRequest['source'];
  target: ToolCapsuleRequest['target'];
  files: Array<{
    filename: string;
    size: number;
    sha256: string;
  }>;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(wanted);
}

function hex(value: unknown, length: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function safeRepository(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    !value.includes('..')
  );
}

function safePythonVersion(value: unknown): value is string {
  return typeof value === 'string' && /^3\.[0-9]{1,2}$/.test(value);
}

function safePackageName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function safeVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.!+_-]*$/.test(value);
}

function safeWheelFilename(value: string): boolean {
  return (
    value.length > 4 &&
    value.endsWith('.whl') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function normalizePackageName(value: string): string {
  return value.toLowerCase().replaceAll(/[._-]+/g, '-');
}

export function validateToolCapsuleRequest(value: unknown): ToolCapsuleRequest {
  if (!isObject(value) || !exactKeys(value, ['schema', 'source', 'target', 'packages'])) {
    throw new Error('TOOL_CAPSULE_REQUEST_INVALID');
  }
  if (value.schema !== TOOL_CAPSULE_REQUEST_SCHEMA) {
    throw new Error('TOOL_CAPSULE_REQUEST_SCHEMA_MISMATCH');
  }
  if (
    !isObject(value.source) ||
    !exactKeys(value.source, ['repository', 'revision', 'lock_blob_sha'])
  ) {
    throw new Error('TOOL_CAPSULE_SOURCE_INVALID');
  }
  if (
    !safeRepository(value.source.repository) ||
    !hex(value.source.revision, 40) ||
    !hex(value.source.lock_blob_sha, 40)
  ) {
    throw new Error('TOOL_CAPSULE_SOURCE_INVALID');
  }
  if (!isObject(value.target) || !exactKeys(value.target, ['python_version', 'platform'])) {
    throw new Error('TOOL_CAPSULE_TARGET_INVALID');
  }
  if (
    !safePythonVersion(value.target.python_version) ||
    value.target.platform !== TOOL_CAPSULE_PLATFORM
  ) {
    throw new Error('TOOL_CAPSULE_TARGET_INVALID');
  }
  if (
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > 128
  ) {
    throw new Error('TOOL_CAPSULE_PACKAGES_INVALID');
  }

  const packages: ToolCapsulePackage[] = [];
  const seenNames = new Set<string>();
  for (const rawPackage of value.packages) {
    if (!isObject(rawPackage) || !exactKeys(rawPackage, ['name', 'version', 'hashes'])) {
      throw new Error('TOOL_CAPSULE_PACKAGE_INVALID');
    }
    if (!safePackageName(rawPackage.name) || !safeVersion(rawPackage.version)) {
      throw new Error('TOOL_CAPSULE_PACKAGE_INVALID');
    }
    const normalizedName = normalizePackageName(rawPackage.name);
    if (normalizedName !== rawPackage.name || seenNames.has(normalizedName)) {
      throw new Error('TOOL_CAPSULE_PACKAGE_NAME_INVALID');
    }
    seenNames.add(normalizedName);
    if (
      !Array.isArray(rawPackage.hashes) ||
      rawPackage.hashes.length === 0 ||
      rawPackage.hashes.length > 64 ||
      rawPackage.hashes.some((item) => !hex(item, 64)) ||
      new Set(rawPackage.hashes).size !== rawPackage.hashes.length
    ) {
      throw new Error('TOOL_CAPSULE_PACKAGE_HASHES_INVALID');
    }
    packages.push({
      name: normalizedName,
      version: rawPackage.version,
      hashes: [...rawPackage.hashes].sort(),
    });
  }

  packages.sort((left, right) => left.name.localeCompare(right.name));
  return {
    schema: TOOL_CAPSULE_REQUEST_SCHEMA,
    source: {
      repository: value.source.repository,
      revision: value.source.revision,
      lock_blob_sha: value.source.lock_blob_sha,
    },
    target: {
      python_version: value.target.python_version,
      platform: TOOL_CAPSULE_PLATFORM,
    },
    packages,
  };
}

export function renderHashedRequirements(requestValue: unknown): string {
  const request = validateToolCapsuleRequest(requestValue);
  return `${request.packages
    .map((pkg) => {
      const hashes = pkg.hashes.map((hash) => `    --hash=sha256:${hash}`).join(' \\\n');
      return `${pkg.name}==${pkg.version} \\\n${hashes}`;
    })
    .join('\n')}\n`;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function wheelFiles(root: string): ToolCapsuleManifest['files'] {
  return readdirSync(root)
    .sort()
    .map((filename) => {
      if (!safeWheelFilename(filename)) throw new Error('TOOL_CAPSULE_WHEEL_FILENAME_INVALID');
      const path = join(root, filename);
      const shape = lstatSync(path);
      if (!shape.isFile() || shape.isSymbolicLink())
        throw new Error('TOOL_CAPSULE_WHEEL_SHAPE_INVALID');
      const bytes = readFileSync(path);
      return { filename, size: bytes.length, sha256: sha256(bytes) };
    });
}

export function buildToolCapsuleManifest(
  requestBytes: Buffer,
  wheelhouse: string,
): ToolCapsuleManifest {
  const request = validateToolCapsuleRequest(JSON.parse(requestBytes.toString('utf8')));
  const files = wheelFiles(wheelhouse);
  if (files.length !== request.packages.length)
    throw new Error('TOOL_CAPSULE_WHEEL_COUNT_MISMATCH');
  return {
    schema: TOOL_CAPSULE_MANIFEST_SCHEMA,
    request_sha256: sha256(requestBytes),
    source: request.source,
    target: request.target,
    files,
  };
}

export function verifyToolCapsule(
  requestBytes: Buffer,
  manifestValue: unknown,
  wheelhouse: string,
): true {
  const expected = buildToolCapsuleManifest(requestBytes, wheelhouse);
  if (
    !isObject(manifestValue) ||
    !exactKeys(manifestValue, ['schema', 'request_sha256', 'source', 'target', 'files'])
  ) {
    throw new Error('TOOL_CAPSULE_MANIFEST_INVALID');
  }
  if (JSON.stringify(manifestValue) !== JSON.stringify(expected)) {
    throw new Error('TOOL_CAPSULE_MANIFEST_MISMATCH');
  }
  return true;
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(args: string[]): void {
  const [command, ...rest] = args;
  if (command === 'verify-request' && rest.length === 1) {
    validateToolCapsuleRequest(parseJsonFile(rest[0] as string));
    return;
  }
  if (command === 'render-requirements' && rest.length === 2) {
    writeFileSync(
      rest[1] as string,
      renderHashedRequirements(parseJsonFile(rest[0] as string)),
    );
    return;
  }
  if (command === 'build-manifest' && rest.length === 3) {
    const requestBytes = readFileSync(rest[0] as string);
    const manifest = buildToolCapsuleManifest(requestBytes, rest[1] as string);
    writeFileSync(rest[2] as string, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === 'verify-capsule' && rest.length === 3) {
    verifyToolCapsule(
      readFileSync(rest[0] as string),
      parseJsonFile(rest[1] as string),
      rest[2] as string,
    );
    return;
  }
  if (command === 'request-target' && rest.length === 1) {
    const request = validateToolCapsuleRequest(parseJsonFile(rest[0] as string));
    process.stdout.write(`${request.target.python_version}\t${request.target.platform}\n`);
    return;
  }
  throw new Error(
    'usage: tool-capsule.ts verify-request <request.json> | render-requirements <request.json> <requirements.txt> | build-manifest <request.json> <wheelhouse> <manifest.json> | verify-capsule <request.json> <manifest.json> <wheelhouse> | request-target <request.json>',
  );
}

const invokedAs = process.argv[1];
if (invokedAs && import.meta.url === pathToFileURL(invokedAs).href) {
  main(process.argv.slice(2));
}
