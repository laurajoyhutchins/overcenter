import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const RUNTIME_ROOTS = new Set(['api', 'lib', 'mcp', 'pages', 'public']);

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

function portablePath(path) {
  return String(path || '').split(sep).join('/');
}

export function runtimePathForDistArtifact(pathInput) {
  const path = portablePath(pathInput);
  if (!path.startsWith('dist/')) return null;
  const target = path.slice('dist/'.length);
  const [root] = target.split('/');
  if (!RUNTIME_ROOTS.has(root) || target === root) return null;
  if (target.includes('\\') || target.split('/').includes('..')) return null;
  return target;
}

async function walk(root, directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, files);
    } else if (entry.isFile()) {
      const path = portablePath(relative(root, absolute));
      const runtimePath = runtimePathForDistArtifact(path);
      if (!runtimePath) continue;
      const content = await readFile(absolute, 'utf8');
      if (content.includes('\u0000')) reject('RUNTIME_ARTIFACT_UTF8_REQUIRED', `runtime artifact must be UTF-8 text: ${path}`);
      files.push({ path, content });
    }
  }
}

export async function readRuntimeArtifactFiles(options = {}) {
  const cwd = options.cwd || process.cwd();
  const root = join(cwd, 'dist');
  const files = [];
  await walk(cwd, root, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function createRuntimeArtifactSourceAdapter(baseAdapter, options = {}) {
  if (!baseAdapter || typeof baseAdapter.observe !== 'function') {
    reject('RUNTIME_ARTIFACT_SOURCE_ADAPTER_INVALID', 'base source adapter with observe() is required');
  }
  const readArtifactFiles = options.readRuntimeArtifactFiles || (() => readRuntimeArtifactFiles({ cwd: options.cwd }));
  const requireArtifact = options.requireRuntimeArtifact !== false;

  return {
    async observe(coordinate) {
      const source = await baseAdapter.observe(coordinate);
      const projected = new Map((source?.files || []).map((file) => [file.path, file]));
      const artifactFiles = await readArtifactFiles();
      const seen = new Set();
      let applied = 0;

      for (const artifact of artifactFiles) {
        const path = runtimePathForDistArtifact(artifact?.path);
        if (!path || !projected.has(path)) continue;
        if (typeof artifact?.content !== 'string' || artifact.content.includes('\u0000')) {
          reject('RUNTIME_ARTIFACT_UTF8_REQUIRED', `runtime artifact must be UTF-8 text: ${artifact?.path || ''}`);
        }
        if (seen.has(path)) reject('RUNTIME_ARTIFACT_DUPLICATE_PATH', `duplicate runtime artifact path: ${path}`);
        seen.add(path);
        projected.set(path, { path, content: artifact.content });
        applied += 1;
      }

      if (requireArtifact && applied === 0) {
        reject('RUNTIME_ARTIFACT_REQUIRED', 'dist contains no established Hatchable runtime artifact targets');
      }

      return {
        ...source,
        files: [...projected.values()].sort((left, right) => left.path.localeCompare(right.path)),
      };
    },
  };
}
