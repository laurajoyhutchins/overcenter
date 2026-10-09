import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE_PATHS = [
  'src/source/source-preparation-profile.json',
  '.overcenter/source-preparation-profile.json',
] as const;
const PROFILE_SCHEMA = 'overcenter-source-preparation-profile/v1';
const RECEIPT_SCHEMA = 'overcenter-source-preparation-receipt/v1';

type Engine = 'ruff' | 'biome' | 'gofmt' | 'rustfmt';

interface PreparationTool {
  engine: Engine;
  version: string;
  extensions: string[];
  safe_fixes: boolean;
}

interface PreparationProfile {
  schema: typeof PROFILE_SCHEMA;
  tools: PreparationTool[];
  max_passes: number;
  timeout_ms: number;
}

export interface SourcePreparationReceipt {
  schema: typeof RECEIPT_SCHEMA;
  status: 'UNCONFIGURED' | 'UNCHANGED' | 'NORMALIZED';
  source_sha: string;
  profile_sha256: string | null;
  proposal_sha256: string;
  normalized_sha256: string;
  changed_paths: string[];
  applied_tools: Engine[];
  passes: number;
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sourcePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/^[A-Za-z]:/.test(path) &&
    ![...path].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git')
  );
}

function validProfile(value: unknown): PreparationProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SOURCE_PREPARATION_PROFILE_INVALID');
  }
  const p = value as Record<string, unknown>;
  if (
    p.schema !== PROFILE_SCHEMA ||
    Object.keys(p).sort().join(',') !== 'max_passes,schema,timeout_ms,tools' ||
    !Number.isSafeInteger(p.max_passes) ||
    (p.max_passes as number) < 1 ||
    (p.max_passes as number) > 3 ||
    !Number.isSafeInteger(p.timeout_ms) ||
    (p.timeout_ms as number) < 100 ||
    (p.timeout_ms as number) > 30000 ||
    !Array.isArray(p.tools) ||
    p.tools.length < 1 ||
    p.tools.length > 4
  ) {
    throw new Error('SOURCE_PREPARATION_PROFILE_INVALID');
  }
  const engines = new Set<Engine>();
  const tools = p.tools.map((raw: unknown): PreparationTool => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('SOURCE_PREPARATION_TOOL_INVALID');
    }
    const t = raw as Record<string, unknown>;
    if (
      Object.keys(t).sort().join(',') !== 'engine,extensions,safe_fixes,version' ||
      !['ruff', 'biome', 'gofmt', 'rustfmt'].includes(String(t.engine)) ||
      typeof t.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(t.version) ||
      !Array.isArray(t.extensions) ||
      t.extensions.length < 1 ||
      t.extensions.some((ext: unknown) => typeof ext !== 'string' || !/^\.[a-z0-9]+$/.test(ext)) ||
      new Set(t.extensions).size !== t.extensions.length ||
      typeof t.safe_fixes !== 'boolean'
    ) {
      throw new Error('SOURCE_PREPARATION_TOOL_INVALID');
    }
    const engine = t.engine as Engine;
    if (engines.has(engine)) throw new Error('SOURCE_PREPARATION_TOOL_DUPLICATE');
    if (t.safe_fixes && engine !== 'ruff')
      throw new Error('SOURCE_PREPARATION_FIX_MODE_UNSUPPORTED');
    engines.add(engine);
    return {
      engine,
      version: t.version,
      extensions: [...(t.extensions as string[])].sort(),
      safe_fixes: t.safe_fixes,
    };
  });
  return {
    schema: PROFILE_SCHEMA,
    tools,
    max_passes: p.max_passes as number,
    timeout_ms: p.timeout_ms as number,
  };
}

function readProfile(
  repo: string,
  sourceSha: string,
): {
  value: PreparationProfile;
  sha256: string;
} | null {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('SOURCE_PREPARATION_BASE_INVALID');
  // Listing a valid tree distinguishes a genuinely absent profile from a
  // provider/checkout failure; failures must never silently disable preparation.
  const listed = git(repo, ['ls-tree', '-r', '--name-only', sourceSha, '--', ...PROFILE_PATHS])
    .trim()
    .split('\n')
    .filter(Boolean);
  const present = PROFILE_PATHS.filter((path) => listed.includes(path));
  if (present.length === 0) return null;
  if (present.length !== 1) throw new Error('SOURCE_PREPARATION_PROFILE_AMBIGUOUS');
  const raw = execFileSync('git', ['-C', repo, 'show', `${sourceSha}:${present[0]}`], {
    maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    return { value: validProfile(JSON.parse(raw.toString('utf8'))), sha256: hash(raw) };
  } catch {
    throw new Error('SOURCE_PREPARATION_PROFILE_INVALID');
  }
}

function digestFiles(
  root: string,
  files: readonly { path: string; content_base64: string | null }[],
): string {
  const digest = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(String(Buffer.byteLength(file.path)));
    digest.update(':');
    digest.update(file.path);
    digest.update(':');
    if (file.content_base64 === null) {
      try {
        lstatSync(join(root, file.path));
        throw new Error(`SOURCE_PREPARATION_DELETION_RECREATED:${file.path}`);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      digest.update('deleted');
    } else {
      const data = readFileSync(join(root, file.path));
      digest.update(String(data.byteLength));
      digest.update(':');
      digest.update(data);
    }
  }
  return digest.digest('hex');
}

function inspectPaths(
  root: string,
  proposed: readonly string[],
  protectedPaths: readonly string[],
): void {
  const allowed = new Set(proposed);
  for (const path of proposed) {
    if (!sourcePath(path) || protectedPaths.some((p) => path === p || path.startsWith(p + '/'))) {
      throw new Error(`SOURCE_PREPARATION_PATH_FORBIDDEN:${path}`);
    }
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      try {
        const stat = lstatSync(join(root, ...parts.slice(0, i)));
        if (stat.isSymbolicLink() || (i === parts.length && !stat.isFile())) {
          throw new Error(`SOURCE_PREPARATION_FILE_MODE_FORBIDDEN:${path}`);
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          break; // A deliberately deleted path.
        }
        throw error;
      }
    }
  }
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const fields = status.split('\0');
  if (fields.pop() !== '') throw new Error('SOURCE_PREPARATION_GIT_STATUS_INVALID');
  for (const field of fields) {
    const state = field.slice(0, 2);
    const path = field.slice(3);
    if (state.includes('R') || state.includes('C') || !allowed.has(path)) {
      throw new Error(`SOURCE_PREPARATION_SCOPE_VIOLATION:${path}`);
    }
  }
  // Porcelain status honors .gitignore. Ignored artifacts are also forbidden.
  const untracked = git(root, ['ls-files', '--others', '-z']);
  for (const path of untracked.split('\0').filter(Boolean)) {
    if (!allowed.has(path)) throw new Error(`SOURCE_PREPARATION_SCOPE_VIOLATION:${path}`);
  }
}

function invoke(root: string, engine: Engine, args: string[], timeoutMs: number): string {
  const queryVersion = args.length === 1 && args[0] === '--version';
  const binary =
    queryVersion && engine === 'gofmt'
      ? 'go'
      : queryVersion && engine === 'rustfmt'
        ? 'rustc'
        : engine;
  const result = spawnSync(
    binary,
    binary === 'go' ? ['version'] : binary === 'rustc' ? ['--version'] : args,
    {
      cwd: root,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.RUNNER_TEMP || '/tmp',
        LC_ALL: 'C',
        ...(process.env.RUSTUP_TOOLCHAIN ? { RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN } : {}),
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `SOURCE_PREPARATION_TOOL_FAILED:${engine}:${String(result.error ?? result.stderr ?? result.status).slice(0, 700)}`,
    );
  }
  return result.stdout;
}

function runTool(
  root: string,
  tool: PreparationTool,
  paths: readonly string[],
  timeoutMs: number,
): void {
  const versionText = invoke(root, tool.engine, ['--version'], timeoutMs);
  const numbers = versionText.match(/\d+\.\d+\.\d+/);
  if (!numbers || numbers[0] !== tool.version) {
    throw new Error(`SOURCE_PREPARATION_TOOL_VERSION_MISMATCH:${tool.engine}`);
  }
  switch (tool.engine) {
    case 'ruff':
      if (tool.safe_fixes) {
        invoke(
          root,
          tool.engine,
          ['check', '--no-cache', '--fix', '--fix-only', '--no-unsafe-fixes', '--', ...paths],
          timeoutMs,
        );
      }
      invoke(root, tool.engine, ['format', '--no-cache', '--', ...paths], timeoutMs);
      break;
    case 'biome':
      invoke(root, tool.engine, ['format', '--write', '--', ...paths], timeoutMs);
      break;
    case 'gofmt':
      invoke(root, tool.engine, ['-w', '--', ...paths], timeoutMs);
      break;
    case 'rustfmt':
      invoke(
        root,
        tool.engine,
        ['--edition', '2021', '--config', 'skip_children=true', '--', ...paths],
        timeoutMs,
      );
      break;
  }
}

/**
 * Canonicalize only the originally proposed paths. The accepted base owns the
 * policy; formatter subprocesses cannot choose their own commands or write set.
 * This is candidate preparation, not verification or an authority grant.
 */
export function prepareSourceCandidate(
  root: string,
  sourceSha: string,
  files: readonly { path: string; content_base64: string | null }[],
  protectedPaths: readonly string[],
): SourcePreparationReceipt {
  const paths = files
    .filter((file) => file.content_base64 !== null)
    .map((file) => file.path)
    .sort();
  const proposedPaths = files.map((file) => file.path).sort();
  inspectPaths(root, proposedPaths, protectedPaths);
  const profile = readProfile(root, sourceSha);
  const before = digestFiles(root, files);
  const applied = profile
    ? profile.value.tools.filter((tool) =>
        paths.some((p) => tool.extensions.some((ext) => p.endsWith(ext))),
      )
    : [];
  let passes = 0;
  if (profile && applied.length) {
    let previous = before;
    let converged = false;
    for (let index = 0; index < profile.value.max_passes; index += 1) {
      passes += 1;
      for (const tool of applied) {
        const applicable = paths.filter((p) => tool.extensions.some((ext) => p.endsWith(ext)));
        runTool(root, tool, applicable, profile.value.timeout_ms);
        inspectPaths(root, proposedPaths, protectedPaths);
      }
      const current = digestFiles(root, files);
      if (current === previous) {
        converged = true;
        break;
      }
      previous = current;
    }
    if (!converged) {
      // A bounded extra read-only check is not enough to establish a fixed point.
      // Requiring a no-change pass detects oscillation and non-idempotence.
      throw new Error('SOURCE_PREPARATION_NOT_CONVERGED');
    }
  }
  inspectPaths(root, proposedPaths, protectedPaths);
  const after = digestFiles(root, files);
  return {
    schema: RECEIPT_SCHEMA,
    status: !profile ? 'UNCONFIGURED' : before === after ? 'UNCHANGED' : 'NORMALIZED',
    source_sha: sourceSha,
    profile_sha256: profile?.sha256 ?? null,
    proposal_sha256: before,
    normalized_sha256: after,
    changed_paths: proposedPaths,
    applied_tools: applied.map((tool) => tool.engine),
    passes,
  };
}
