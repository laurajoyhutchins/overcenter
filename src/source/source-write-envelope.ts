import { assertExactKeys, isData } from '../validation.ts';

export interface SourceWriteEnvelope {
  allowed_roots: string[];
  exact_paths: string[];
  denied_roots: string[];
  denied_paths: string[];
  max_changed_files: number | null;
  max_changed_bytes: number | null;
}

export interface SourceWriteDeltaEntry {
  path: string;
  /** Sum of the before and after Git blob sizes for this changed path. */
  changed_bytes: number;
}

function validRepositoryPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return false;
  }
  return value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

function controlPlanePath(path: string): boolean {
  return (
    path === '.overcenter' ||
    path.startsWith('.overcenter/') ||
    path === '.github' ||
    path.startsWith('.github/')
  );
}

function validSourceWritablePath(value: unknown): value is string {
  return validRepositoryPath(value) && !controlPlanePath(value);
}

function validScopeRoot(value: unknown): value is string {
  return value === '.' || validRepositoryPath(value);
}

function canonicalPaths(value: unknown, valid: (value: unknown) => value is string): string[] {
  if (!Array.isArray(value) || value.some((path) => !valid(path))) {
    throw new Error('SOURCE_TASK_WRITE_ENVELOPE_INVALID');
  }
  const paths = value as string[];
  if (new Set(paths).size !== paths.length) {
    throw new Error('SOURCE_TASK_WRITE_ENVELOPE_INVALID');
  }
  return [...paths].sort();
}

function normalizedWriteEnvelope(
  writablePaths: readonly string[],
  value: unknown,
): SourceWriteEnvelope {
  if (value === undefined) {
    if (writablePaths.length === 0) throw new Error('SOURCE_TASK_WRITABLE_PATHS_INVALID');
    return {
      allowed_roots: [],
      exact_paths: [...writablePaths].sort(),
      denied_roots: [],
      denied_paths: [],
      max_changed_files: null,
      max_changed_bytes: null,
    };
  }
  if (writablePaths.length !== 0) throw new Error('SOURCE_TASK_WRITE_ENVELOPE_AMBIGUOUS');
  if (!isData(value)) throw new Error('SOURCE_TASK_WRITE_ENVELOPE_INVALID');
  assertExactKeys(
    value,
    [
      'allowed_roots',
      'exact_paths',
      'denied_roots',
      'denied_paths',
      'max_changed_files',
      'max_changed_bytes',
    ],
    [],
    'SOURCE_TASK_WRITE_ENVELOPE_INVALID',
  );
  const allowedRoots = canonicalPaths(value.allowed_roots, validScopeRoot);
  const exactPaths = canonicalPaths(value.exact_paths, validSourceWritablePath);
  const deniedRoots = canonicalPaths(value.denied_roots, validScopeRoot);
  const deniedPaths = canonicalPaths(value.denied_paths, validRepositoryPath);
  const legacyExact =
    allowedRoots.length === 0 &&
    exactPaths.length > 0 &&
    deniedRoots.length === 0 &&
    deniedPaths.length === 0 &&
    value.max_changed_files === null &&
    value.max_changed_bytes === null;
  if (
    !legacyExact &&
    (!Number.isSafeInteger(value.max_changed_files) ||
      (value.max_changed_files as number) <= 0 ||
      !Number.isSafeInteger(value.max_changed_bytes) ||
      (value.max_changed_bytes as number) <= 0)
  ) {
    throw new Error('SOURCE_TASK_WRITE_ENVELOPE_BUDGET_INVALID');
  }
  if (!allowedRoots.length && !exactPaths.length) {
    throw new Error('SOURCE_TASK_WRITE_ENVELOPE_EMPTY');
  }
  return {
    allowed_roots: allowedRoots,
    exact_paths: exactPaths,
    denied_roots: deniedRoots,
    denied_paths: deniedPaths,
    max_changed_files: value.max_changed_files as number,
    max_changed_bytes: value.max_changed_bytes as number,
  };
}

export function normalizeSourceWriteEnvelope(taskValue: unknown): SourceWriteEnvelope {
  if (!isData(taskValue) || !Array.isArray(taskValue.writable_paths)) {
    throw new Error('SOURCE_TASK_INVALID');
  }
  if (!taskValue.writable_paths.every(validSourceWritablePath)) {
    throw new Error('SOURCE_TASK_WRITABLE_PATH_INVALID');
  }
  if (new Set(taskValue.writable_paths).size !== taskValue.writable_paths.length) {
    throw new Error('SOURCE_TASK_WRITABLE_PATH_DUPLICATE');
  }
  return normalizedWriteEnvelope(taskValue.writable_paths, taskValue.write_envelope);
}

function pathWithinRoot(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}

export function assertSourceWriteEnvelope(
  taskValue: unknown,
  deltaEntries: readonly SourceWriteDeltaEntry[],
  protectedPaths: readonly string[],
): string[] {
  const envelope = normalizeSourceWriteEnvelope(taskValue);
  if (!deltaEntries.length) throw new Error('SOURCE_CANDIDATE_EMPTY');
  if (envelope.max_changed_files !== null && deltaEntries.length > envelope.max_changed_files) {
    throw new Error('SOURCE_WRITE_ENVELOPE_FILE_BUDGET_EXCEEDED');
  }
  let changedBytes = 0;
  for (const entry of deltaEntries) {
    if (
      !validRepositoryPath(entry.path) ||
      !Number.isSafeInteger(entry.changed_bytes) ||
      entry.changed_bytes < 0
    ) {
      throw new Error('SOURCE_WRITE_ENVELOPE_DELTA_INVALID');
    }
    changedBytes += entry.changed_bytes;
    if (!Number.isSafeInteger(changedBytes)) {
      throw new Error('SOURCE_WRITE_ENVELOPE_DELTA_INVALID');
    }
    if (protectedPaths.some((root) => pathWithinRoot(entry.path, root))) {
      throw new Error('SOURCE_CONTROL_PLANE_MUTATION_FORBIDDEN');
    }
    const allowed =
      envelope.exact_paths.includes(entry.path) ||
      envelope.allowed_roots.some((root) => pathWithinRoot(entry.path, root));
    const denied =
      envelope.denied_paths.includes(entry.path) ||
      envelope.denied_roots.some((root) => pathWithinRoot(entry.path, root));
    if (!allowed || denied) throw new Error(`SOURCE_PROPOSAL_SCOPE_VIOLATION:${entry.path}`);
  }
  if (envelope.max_changed_bytes !== null && changedBytes > envelope.max_changed_bytes) {
    throw new Error('SOURCE_WRITE_ENVELOPE_BYTE_BUDGET_EXCEEDED');
  }
  return deltaEntries.map((entry) => entry.path).sort();
}
