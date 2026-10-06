import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../effect-adapter.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';

export const SOURCE_TASK_SCHEMA = 'overcenter-source-task/v1' as const;
export const SOURCE_ASSIGNMENT_SCHEMA = 'overcenter-source-assignment/v1' as const;
export const SOURCE_PROPOSAL_SCHEMA = 'overcenter-source-proposal/v1' as const;
export const SOURCE_CANDIDATE_SCHEMA = 'overcenter-source-candidate/v1' as const;

export interface SourceTaskAcceptance extends Record<string, unknown> {
  verifier: 'tcb-finding-absent/v1';
  finding_id: string;
}

export interface SourceTaskPacket extends Record<string, unknown> {
  schema: typeof SOURCE_TASK_SCHEMA;
  kind: 'source-change';
  objective: string;
  writable_paths: string[];
  write_envelope?: SourceWriteEnvelope;
  effect_contract: typeof GITHUB_SOURCE_INTEGRATION_EFFECT;
  acceptance?: SourceTaskAcceptance;
  context?: Record<string, unknown>;
}

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
  changed_bytes: number;
}

export interface SourceClaimBinding {
  obligation_key: string;
  run_id: string;
  claimed_revision: string;
  source_sha: string;
}

export interface SourceAssignment {
  schema: typeof SOURCE_ASSIGNMENT_SCHEMA;
  obligation_id: string;
  task: SourceTaskPacket;
  claim: SourceClaimBinding;
  proposal_schema: typeof SOURCE_PROPOSAL_SCHEMA;
}

export interface SourceProposalFile {
  path: string;
  content_base64: string | null;
}

export interface SourceProposal {
  schema: typeof SOURCE_PROPOSAL_SCHEMA;
  run_id: string;
  claimed_revision: string;
  claimed_source_sha: string;
  files: SourceProposalFile[];
}

export interface SourceCandidate {
  schema: typeof SOURCE_CANDIDATE_SCHEMA;
  obligation_key: string;
  run_id: string;
  claimed_revision: string;
  claimed_source_sha: string;
  commit_sha: string;
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
    return {
      allowed_roots: [],
      exact_paths: [...writablePaths].sort(),
      denied_roots: [],
      denied_paths: [],
      max_changed_files: null,
      max_changed_bytes: null,
    };
  }
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
  return normalizedWriteEnvelope(
    taskValue.writable_paths as string[],
    taskValue.write_envelope,
  );
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
  if (
    envelope.max_changed_files !== null &&
    deltaEntries.length > envelope.max_changed_files
  ) {
    throw new Error('SOURCE_WRITE_ENVELOPE_FILE_BUDGET_EXCEEDED');
  }
  let changedBytes = 0;
  for (const entry of deltaEntries) {
    if (!validRepositoryPath(entry.path) || !Number.isSafeInteger(entry.changed_bytes) || entry.changed_bytes < 0) {
      throw new Error('SOURCE_WRITE_ENVELOPE_DELTA_INVALID');
    }
    changedBytes += entry.changed_bytes;
    if (!Number.isSafeInteger(changedBytes)) throw new Error('SOURCE_WRITE_ENVELOPE_DELTA_INVALID');
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

function exactSha(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(error);
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

export function validateSourceTaskPacket(value: unknown): SourceTaskPacket {
  if (!isData(value)) throw new Error('SOURCE_TASK_INVALID');
  assertExactKeys(
    value,
    ['schema', 'kind', 'objective', 'writable_paths'],
    ['effect_contract', 'acceptance', 'context', 'write_envelope'],
    'SOURCE_TASK_INVALID',
  );
  if (value.schema !== SOURCE_TASK_SCHEMA) throw new Error('SOURCE_TASK_SCHEMA_MISMATCH');
  if (value.kind !== 'source-change') throw new Error('SOURCE_TASK_KIND_INVALID');
  assertNonEmptyString(value.objective, 'SOURCE_TASK_OBJECTIVE_INVALID');
  if (
    value.effect_contract !== undefined &&
    value.effect_contract !== GITHUB_SOURCE_INTEGRATION_EFFECT
  ) {
    throw new Error('SOURCE_TASK_EFFECT_CONTRACT_INVALID');
  }

  if (!Array.isArray(value.writable_paths)) {
    throw new Error('SOURCE_TASK_WRITABLE_PATHS_INVALID');
  }
  if (!value.writable_paths.every(validSourceWritablePath)) {
    throw new Error('SOURCE_TASK_WRITABLE_PATH_INVALID');
  }
  if (new Set(value.writable_paths).size !== value.writable_paths.length) {
    throw new Error('SOURCE_TASK_WRITABLE_PATH_DUPLICATE');
  }
  const writeEnvelope = normalizedWriteEnvelope(value.writable_paths, value.write_envelope);
  if (value.write_envelope !== undefined && value.writable_paths.length !== 0) {
    throw new Error('SOURCE_TASK_WRITE_ENVELOPE_AMBIGUOUS');
  }
  if (value.write_envelope === undefined && value.writable_paths.length === 0) {
    throw new Error('SOURCE_TASK_WRITABLE_PATHS_INVALID');
  }

  let acceptance: SourceTaskAcceptance | undefined;
  if (value.acceptance !== undefined) {
    if (!isData(value.acceptance)) throw new Error('SOURCE_TASK_ACCEPTANCE_INVALID');
    assertExactKeys(
      value.acceptance,
      ['verifier', 'finding_id'],
      [],
      'SOURCE_TASK_ACCEPTANCE_INVALID',
    );
    if (value.acceptance.verifier !== 'tcb-finding-absent/v1') {
      throw new Error('SOURCE_TASK_ACCEPTANCE_VERIFIER_INVALID');
    }
    assertNonEmptyString(value.acceptance.finding_id, 'SOURCE_TASK_ACCEPTANCE_FINDING_INVALID');
    if (!value.acceptance.finding_id.startsWith('tcb:')) {
      throw new Error('SOURCE_TASK_ACCEPTANCE_FINDING_INVALID');
    }
    acceptance = {
      verifier: 'tcb-finding-absent/v1',
      finding_id: value.acceptance.finding_id,
    };
  }
  if (value.context !== undefined && !isData(value.context)) {
    throw new Error('SOURCE_TASK_CONTEXT_INVALID');
  }

  return {
    schema: SOURCE_TASK_SCHEMA,
    kind: 'source-change',
    objective: value.objective,
    writable_paths: [...value.writable_paths].sort(),
    ...(value.write_envelope === undefined ? {} : { write_envelope: writeEnvelope }),
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    ...(acceptance ? { acceptance } : {}),
    ...(value.context === undefined ? {} : { context: structuredClone(value.context) }),
  };
}

export function bindSourceClaim(
  obligationKey: string,
  runId: string,
  claimedRevision: string,
  sourceSha: string,
): SourceClaimBinding {
  assertNonEmptyString(obligationKey, 'SOURCE_CLAIM_OBLIGATION_KEY_INVALID');
  assertNonEmptyString(runId, 'SOURCE_CLAIM_RUN_ID_INVALID');
  assertNonEmptyString(claimedRevision, 'SOURCE_CLAIM_REVISION_INVALID');
  exactSha(sourceSha, 'SOURCE_CLAIM_SOURCE_SHA_INVALID');
  return {
    obligation_key: obligationKey,
    run_id: runId,
    claimed_revision: claimedRevision,
    source_sha: sourceSha,
  };
}

export function buildSourceAssignment(
  obligationId: string,
  task: unknown,
  claim: SourceClaimBinding,
): SourceAssignment {
  assertNonEmptyString(obligationId, 'SOURCE_ASSIGNMENT_OBLIGATION_INVALID');
  return {
    schema: SOURCE_ASSIGNMENT_SCHEMA,
    obligation_id: obligationId,
    task: validateSourceTaskPacket(task),
    claim: bindSourceClaim(
      claim.obligation_key,
      claim.run_id,
      claim.claimed_revision,
      claim.source_sha,
    ),
    proposal_schema: SOURCE_PROPOSAL_SCHEMA,
  };
}

export function validateSourceAssignment(value: unknown): SourceAssignment {
  if (!isData(value)) throw new Error('SOURCE_ASSIGNMENT_INVALID');
  assertExactKeys(
    value,
    ['schema', 'obligation_id', 'task', 'claim', 'proposal_schema'],
    [],
    'SOURCE_ASSIGNMENT_INVALID',
  );
  if (value.schema !== SOURCE_ASSIGNMENT_SCHEMA) {
    throw new Error('SOURCE_ASSIGNMENT_SCHEMA_MISMATCH');
  }
  if (value.proposal_schema !== SOURCE_PROPOSAL_SCHEMA) {
    throw new Error('SOURCE_ASSIGNMENT_PROPOSAL_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.obligation_id, 'SOURCE_ASSIGNMENT_OBLIGATION_INVALID');
  if (!isData(value.claim)) throw new Error('SOURCE_ASSIGNMENT_CLAIM_INVALID');
  assertExactKeys(
    value.claim,
    ['obligation_key', 'run_id', 'claimed_revision', 'source_sha'],
    [],
    'SOURCE_ASSIGNMENT_CLAIM_INVALID',
  );
  assertNonEmptyString(value.claim.obligation_key, 'SOURCE_ASSIGNMENT_CLAIM_KEY_INVALID');
  assertNonEmptyString(value.claim.run_id, 'SOURCE_ASSIGNMENT_CLAIM_RUN_INVALID');
  assertNonEmptyString(value.claim.claimed_revision, 'SOURCE_ASSIGNMENT_CLAIM_REVISION_INVALID');
  if (typeof value.claim.source_sha !== 'string') {
    throw new Error('SOURCE_ASSIGNMENT_CLAIM_SOURCE_INVALID');
  }
  return buildSourceAssignment(
    value.obligation_id,
    value.task,
    bindSourceClaim(
      value.claim.obligation_key,
      value.claim.run_id,
      value.claim.claimed_revision,
      value.claim.source_sha,
    ),
  );
}

export function validateSourceProposal(
  value: unknown,
  taskValue: unknown,
  claim: SourceClaimBinding,
): SourceProposal {
  const task = validateSourceTaskPacket(taskValue);
  const writeEnvelope = normalizeSourceWriteEnvelope(task);
  if (!isData(value)) throw new Error('SOURCE_PROPOSAL_INVALID');
  assertExactKeys(
    value,
    ['schema', 'run_id', 'claimed_revision', 'claimed_source_sha', 'files'],
    [],
    'SOURCE_PROPOSAL_INVALID',
  );
  if (value.schema !== SOURCE_PROPOSAL_SCHEMA) {
    throw new Error('SOURCE_PROPOSAL_SCHEMA_MISMATCH');
  }
  if (value.run_id !== claim.run_id) throw new Error('SOURCE_PROPOSAL_RUN_MISMATCH');
  if (value.claimed_revision !== claim.claimed_revision) {
    throw new Error('SOURCE_PROPOSAL_REVISION_MISMATCH');
  }
  if (value.claimed_source_sha !== claim.source_sha) {
    throw new Error('SOURCE_PROPOSAL_SOURCE_MISMATCH');
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error('SOURCE_PROPOSAL_FILES_INVALID');
  }

  const files = value.files.map((candidate, index): SourceProposalFile => {
    if (!isData(candidate)) throw new Error(`SOURCE_PROPOSAL_FILE_INVALID:${index}`);
    assertExactKeys(
      candidate,
      ['path', 'content_base64'],
      [],
      `SOURCE_PROPOSAL_FILE_INVALID:${index}`,
    );
    if (!validSourceWritablePath(candidate.path)) {
      throw new Error(`SOURCE_PROPOSAL_PATH_INVALID:${index}`);
    }
    const allowed =
      writeEnvelope.exact_paths.includes(candidate.path) ||
      writeEnvelope.allowed_roots.some((root) => pathWithinRoot(candidate.path, root));
    const denied =
      writeEnvelope.denied_paths.includes(candidate.path) ||
      writeEnvelope.denied_roots.some((root) => pathWithinRoot(candidate.path, root));
    if (!allowed || denied) {
      throw new Error(`SOURCE_PROPOSAL_SCOPE_VIOLATION:${candidate.path}`);
    }
    if (candidate.content_base64 !== null && !canonicalBase64(candidate.content_base64)) {
      throw new Error(`SOURCE_PROPOSAL_CONTENT_INVALID:${index}`);
    }
    return {
      path: candidate.path,
      content_base64: candidate.content_base64,
    };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('SOURCE_PROPOSAL_PATH_DUPLICATE');
  }

  return {
    schema: SOURCE_PROPOSAL_SCHEMA,
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    claimed_source_sha: claim.source_sha,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function validateSourceCandidate(
  value: unknown,
  claim: SourceClaimBinding,
): SourceCandidate {
  if (!isData(value)) throw new Error('SOURCE_CANDIDATE_INVALID');
  assertExactKeys(
    value,
    ['schema', 'obligation_key', 'run_id', 'claimed_revision', 'claimed_source_sha', 'commit_sha'],
    [],
    'SOURCE_CANDIDATE_INVALID',
  );
  if (value.schema !== SOURCE_CANDIDATE_SCHEMA) {
    throw new Error('SOURCE_CANDIDATE_SCHEMA_MISMATCH');
  }
  if (value.obligation_key !== claim.obligation_key) {
    throw new Error('SOURCE_CANDIDATE_OBLIGATION_MISMATCH');
  }
  if (value.run_id !== claim.run_id) throw new Error('SOURCE_CANDIDATE_RUN_MISMATCH');
  if (value.claimed_revision !== claim.claimed_revision) {
    throw new Error('SOURCE_CANDIDATE_REVISION_MISMATCH');
  }
  if (value.claimed_source_sha !== claim.source_sha) {
    throw new Error('SOURCE_CANDIDATE_SOURCE_MISMATCH');
  }
  exactSha(value.commit_sha, 'SOURCE_CANDIDATE_COMMIT_SHA_INVALID');

  return {
    schema: SOURCE_CANDIDATE_SCHEMA,
    obligation_key: claim.obligation_key,
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    claimed_source_sha: claim.source_sha,
    commit_sha: value.commit_sha,
  };
}
