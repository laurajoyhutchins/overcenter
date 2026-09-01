export const PRODUCTION_MATERIALIZATION_SCHEMA = 'production-materialization-v2' as const;
export const SOURCE_MATERIALIZATION_RECEIPT_PATH = 'public/.overcenter/source-materialization.json' as const;

const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type ProductionMaterializationIntent = Readonly<{ repo: string }>;

export type ProductionSourceCoordinate = Readonly<{
  repository: string;
  branch: string;
  revision: string;
}>;

export type ProductionSourceFile = Readonly<{
  path: string;
  content: string;
}>;

export type ProductionSourceObservation = ProductionSourceCoordinate & Readonly<{
  files: readonly ProductionSourceFile[];
}>;

export type RuntimeSourceFile = Readonly<{
  path: string;
  hash: string;
  size: number | null;
}>;

export type ProductionRuntimeObservation = Readonly<{
  runtime_ref: string;
  version: number;
  files: readonly RuntimeSourceFile[];
  verified_revision?: string | null;
  verification_ref?: string | null;
}>;

export type MaterializedSourceRecord = Readonly<{
  path: string;
  content: string;
  hash: string;
  size: number;
}>;

export type ProductionMaterializationPlan = Readonly<{
  repository: string;
  branch: string;
  revision: string;
  runtime_ref: string;
  expected_version: number;
  target_version: number;
  source_manifest_sha256: string;
  source_path_count: number;
  desired_files: readonly MaterializedSourceRecord[];
  writes: readonly Readonly<{ path: string; content: string }>[];
  deletes: readonly string[];
}>;

export type ProductionRuntimeDeployment = Readonly<{
  runtime_ref: string;
  version: number;
}>;

export type ProductionVerificationResult = Readonly<{
  ok: boolean;
  verification_ref: string;
}>;

export type ProductionMaterializationResult = Readonly<{
  ok: true;
  schema: typeof PRODUCTION_MATERIALIZATION_SCHEMA;
  outcome: 'already_materialized' | 'materialized';
  repository: string;
  branch: string;
  revision: string;
  runtime_ref: string;
  deployment_version: number;
  source_manifest_sha256: string;
  verification_ref: string;
}>;

export type ProductionMaterializationPorts = Readonly<{
  resolveProductionSource(repo: string): Promise<ProductionSourceCoordinate>;
  observeSource(coordinate: ProductionSourceCoordinate): Promise<ProductionSourceObservation>;
  observeRuntime(repo: string): Promise<ProductionRuntimeObservation>;
  normalizeSourceContent?(file: ProductionSourceFile): Promise<string> | string;
  stageRuntime(plan: ProductionMaterializationPlan): Promise<void>;
  inspectRuntimeDraft(runtimeRef: string): Promise<ProductionRuntimeObservation>;
  deployRuntime(plan: ProductionMaterializationPlan): Promise<ProductionRuntimeDeployment>;
  inspectImmutableDeployment(request: ProductionRuntimeDeployment): Promise<ProductionRuntimeObservation>;
  verifyProduction(request: Readonly<{
    repository: string;
    branch: string;
    revision: string;
    runtime_ref: string;
    version: number;
    source_manifest_sha256: string;
  }>): Promise<ProductionVerificationResult>;
}>;

export class ProductionMaterializationRejected extends Error {
  readonly code: string;
  readonly may_have_mutated = false as const;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'ProductionMaterializationRejected';
    this.code = code;
  }
}

export class ProductionMaterializationFailure extends Error {
  readonly code: string;
  readonly may_have_mutated = true as const;

  constructor(code: string, message = code, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProductionMaterializationFailure';
    this.code = code;
  }
}

function reject(code: string, message = code): never {
  throw new ProductionMaterializationRejected(code, message);
}

function postEffectFailure(code: string, message = code): never {
  throw Object.assign(new Error(message), { code });
}

function postMutation(error: unknown): ProductionMaterializationFailure {
  if (error instanceof ProductionMaterializationFailure) return error;
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : 'PRODUCTION_MATERIALIZATION_INDETERMINATE';
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error);
  return new ProductionMaterializationFailure(code, message, { cause:error });
}

function normalizeRepo(value: string): string {
  const repo = String(value || '').trim();
  if (!REPO.test(repo)) reject('PRODUCTION_MATERIALIZATION_REPOSITORY_INVALID', 'repo must be in owner/name form');
  return repo;
}

function normalizeRevision(value: string, field: string): string {
  const revision = String(value || '').trim().toLowerCase();
  if (!SHA40.test(revision)) reject('PRODUCTION_MATERIALIZATION_REVISION_INVALID', `${field} must be an exact 40-character Git SHA`);
  return revision;
}

function normalizeVersion(value: number, field: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) reject('PRODUCTION_MATERIALIZATION_RUNTIME_INVALID', `${field} must be a positive integer`);
  return version;
}

function runtimePath(pathInput: string): boolean {
  const path = String(pathInput || '');
  if (path === SOURCE_MATERIALIZATION_RECEIPT_PATH) return false;
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) return false;
  if (['hatchable.toml', 'package.json', 'seed.sql'].includes(path)) return true;
  if (/^migrations\/[^/]+\.sql$/.test(path)) return true;
  return /^(api|lib|mcp|pages|public)\/.+/.test(path);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(content: string): Promise<Readonly<{ hash: string; size: number }>> {
  const bytes = new TextEncoder().encode(content);
  const hash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  return Object.freeze({ hash, size:bytes.byteLength });
}

function canonicalJson(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(normalize);
    const record = input as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) result[key] = normalize(record[key]);
    }
    return result;
  }
  return JSON.stringify(normalize(value));
}

async function desiredRecords(
  files: readonly ProductionSourceFile[],
  normalizeContent?: ProductionMaterializationPorts['normalizeSourceContent'],
): Promise<readonly MaterializedSourceRecord[]> {
  const seen = new Set<string>();
  const records: MaterializedSourceRecord[] = [];
  for (const file of files) {
    const path = String(file?.path || '');
    if (!runtimePath(path)) continue;
    if (seen.has(path)) reject('PRODUCTION_MATERIALIZATION_DUPLICATE_SOURCE_PATH', `duplicate source path: ${path}`);
    if (typeof file?.content !== 'string' || file.content.includes('\u0000')) reject('PRODUCTION_MATERIALIZATION_SOURCE_INVALID', `source must be UTF-8 text: ${path}`);
    seen.add(path);
    const content = normalizeContent ? await normalizeContent(file) : file.content;
    if (typeof content !== 'string' || content.includes('\u0000')) reject('PRODUCTION_MATERIALIZATION_SOURCE_INVALID', `normalized source must be UTF-8 text: ${path}`);
    const identity = await digest(content);
    records.push(Object.freeze({ path, content, hash:identity.hash, size:identity.size }));
  }
  return Object.freeze(records.sort((left, right) => left.path.localeCompare(right.path)));
}

async function manifestHash(records: readonly MaterializedSourceRecord[]): Promise<string> {
  const canonical = canonicalJson(records.map((record) => ({ path:record.path, sha256:record.hash, size:record.size })));
  return (await digest(canonical)).hash;
}

function runtimeSourceMap(files: readonly RuntimeSourceFile[]): Map<string, RuntimeSourceFile> {
  const result = new Map<string, RuntimeSourceFile>();
  for (const file of files) {
    const path = String(file?.path || '');
    if (!runtimePath(path)) continue;
    if (result.has(path)) reject('PRODUCTION_MATERIALIZATION_RUNTIME_INVALID', `duplicate runtime path: ${path}`);
    result.set(path, file);
  }
  return result;
}

function sourceMatches(files: readonly RuntimeSourceFile[], records: readonly MaterializedSourceRecord[], requireSize: boolean): boolean {
  const observed = runtimeSourceMap(files);
  if (observed.size !== records.length) return false;
  for (const record of records) {
    const file = observed.get(record.path);
    if (!file || String(file.hash || '').toLowerCase() !== record.hash) return false;
    if (requireSize && Number(file.size) !== record.size) return false;
  }
  return true;
}

function exactVerifiedRevision(observation: ProductionRuntimeObservation, revision: string): boolean {
  const verifiedRevision = typeof observation.verified_revision === 'string' ? observation.verified_revision.trim().toLowerCase() : '';
  const verificationRef = typeof observation.verification_ref === 'string' ? observation.verification_ref.trim() : '';
  return verifiedRevision === revision && verificationRef.length > 0;
}

export async function materializeProduction(
  intent: ProductionMaterializationIntent,
  ports: ProductionMaterializationPorts,
): Promise<ProductionMaterializationResult> {
  const repository = normalizeRepo(intent.repo);
  const coordinate = await ports.resolveProductionSource(repository);
  const revision = normalizeRevision(coordinate.revision, 'production revision');
  if (coordinate.repository !== repository || !String(coordinate.branch || '').trim()) {
    reject('PRODUCTION_MATERIALIZATION_SOURCE_COORDINATE_INVALID', 'resolved production source coordinate is invalid');
  }

  const source = await ports.observeSource({ repository, branch:coordinate.branch, revision });
  if (source.repository !== repository || source.branch !== coordinate.branch || normalizeRevision(source.revision, 'observed source revision') !== revision) {
    reject('PRODUCTION_MATERIALIZATION_SOURCE_STALE', 'source observation does not match the resolved production revision');
  }
  const records = await desiredRecords(source.files, ports.normalizeSourceContent);
  const sourceManifestSha256 = await manifestHash(records);

  const runtime = await ports.observeRuntime(repository);
  const expectedVersion = normalizeVersion(runtime.version, 'runtime version');
  if (!String(runtime.runtime_ref || '').trim()) reject('PRODUCTION_MATERIALIZATION_RUNTIME_INVALID', 'runtime_ref is required');

  if (sourceMatches(runtime.files, records, true) && exactVerifiedRevision(runtime, revision)) {
    return Object.freeze({
      ok:true,
      schema:PRODUCTION_MATERIALIZATION_SCHEMA,
      outcome:'already_materialized',
      repository,
      branch:coordinate.branch,
      revision,
      runtime_ref:runtime.runtime_ref,
      deployment_version:expectedVersion,
      source_manifest_sha256:sourceManifestSha256,
      verification_ref:String(runtime.verification_ref),
    });
  }

  const current = runtimeSourceMap(runtime.files);
  const desiredPaths = new Set(records.map((record) => record.path));
  const writes = records
    .filter((record) => {
      const observed = current.get(record.path);
      return !observed || String(observed.hash || '').toLowerCase() !== record.hash || (observed.size !== null && Number(observed.size) !== record.size);
    })
    .map((record) => Object.freeze({ path:record.path, content:record.content }));
  const deletes = [...current.keys()].filter((path) => !desiredPaths.has(path)).sort();
  const plan: ProductionMaterializationPlan = Object.freeze({
    repository,
    branch:coordinate.branch,
    revision,
    runtime_ref:runtime.runtime_ref,
    expected_version:expectedVersion,
    target_version:expectedVersion + 1,
    source_manifest_sha256:sourceManifestSha256,
    source_path_count:records.length,
    desired_files:records,
    writes:Object.freeze(writes),
    deletes:Object.freeze(deletes),
  });

  try {
    await ports.stageRuntime(plan);
    const draft = await ports.inspectRuntimeDraft(plan.runtime_ref);
    if (normalizeVersion(draft.version, 'draft version') !== expectedVersion || !sourceMatches(draft.files, records, false)) {
      postEffectFailure('PRODUCTION_MATERIALIZATION_MISMATCH', 'staged runtime does not match the exact desired source');
    }

    const deployed = await ports.deployRuntime(plan);
    if (deployed.runtime_ref !== plan.runtime_ref || normalizeVersion(deployed.version, 'deployment version') !== plan.target_version) {
      postEffectFailure('PRODUCTION_MATERIALIZATION_MISMATCH', 'runtime deployment did not produce the exact immediate successor');
    }
    const immutable = await ports.inspectImmutableDeployment(deployed);
    if (immutable.runtime_ref !== plan.runtime_ref || normalizeVersion(immutable.version, 'immutable deployment version') !== plan.target_version || !sourceMatches(immutable.files, records, true)) {
      postEffectFailure('PRODUCTION_MATERIALIZATION_MISMATCH', 'immutable runtime deployment does not match the exact desired source');
    }

    const verification = await ports.verifyProduction({
      repository,
      branch:coordinate.branch,
      revision,
      runtime_ref:plan.runtime_ref,
      version:plan.target_version,
      source_manifest_sha256:sourceManifestSha256,
    });
    if (verification.ok !== true || !String(verification.verification_ref || '').trim()) {
      postEffectFailure('PRODUCTION_MATERIALIZATION_VERIFICATION_FAILED');
    }

    return Object.freeze({
      ok:true,
      schema:PRODUCTION_MATERIALIZATION_SCHEMA,
      outcome:'materialized',
      repository,
      branch:coordinate.branch,
      revision,
      runtime_ref:plan.runtime_ref,
      deployment_version:plan.target_version,
      source_manifest_sha256:sourceManifestSha256,
      verification_ref:verification.verification_ref,
    });
  } catch (error) {
    throw postMutation(error);
  }
}
