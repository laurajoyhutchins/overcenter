import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BEHAVIORAL_CHECKSUM_ORACLE_SCHEMA =
  'overcenter-semantic-scaling-behavioral-oracle/v1' as const;

type ExpectedState = 'pass' | 'fail';

export interface BehavioralChecksumFixture {
  schema: typeof BEHAVIORAL_CHECKSUM_ORACLE_SCHEMA;
  task_id: string;
  historical_pr: number;
  base_revision: string;
  candidate_revision: string;
  source_path: string;
  base_blob_sha: string;
  candidate_blob_sha: string;
  base_producer: string;
  candidate_producer: string;
  consumer: string;
  authoritative_claim: string;
  narrowed_from: string;
  residual_judgment: string;
  expected: {
    base_after_relocation: ExpectedState;
    candidate_after_relocation: ExpectedState;
    candidate_after_tamper: ExpectedState;
  };
}

export interface BehavioralChecksumOracleResult {
  schema: 'overcenter-semantic-scaling-behavioral-oracle-result/v1';
  source_revision: string;
  fixture_sha256: string;
  task_id: string;
  classification: 'frontier-limited';
  authoritative_claim: string;
  narrowed_from: string;
  residual_judgment: string;
  historical_identity: {
    base_revision: string;
    candidate_revision: string;
    source_path: string;
    base_blob_sha: string;
    candidate_blob_sha: string;
  };
  scenarios: {
    base_after_relocation: ExpectedState;
    candidate_after_relocation: ExpectedState;
    candidate_after_tamper: ExpectedState;
  };
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`BEHAVIORAL_CHECKSUM_INVALID_STRING:${field}`);
  }
}

function requireSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`BEHAVIORAL_CHECKSUM_INVALID_SHA:${field}`);
  }
}

export function validateBehavioralChecksumFixture(value: unknown): BehavioralChecksumFixture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('BEHAVIORAL_CHECKSUM_FIXTURE_INVALID');
  }
  const fixture = value as Record<string, unknown>;
  const keys = Object.keys(fixture).sort();
  const expectedKeys = [
    'authoritative_claim',
    'base_blob_sha',
    'base_producer',
    'base_revision',
    'candidate_blob_sha',
    'candidate_producer',
    'candidate_revision',
    'consumer',
    'expected',
    'historical_pr',
    'narrowed_from',
    'residual_judgment',
    'schema',
    'source_path',
    'task_id',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error('BEHAVIORAL_CHECKSUM_FIXTURE_KEYS_INVALID');
  }
  if (fixture.schema !== BEHAVIORAL_CHECKSUM_ORACLE_SCHEMA) {
    throw new Error('BEHAVIORAL_CHECKSUM_FIXTURE_SCHEMA_INVALID');
  }
  if (!Number.isSafeInteger(fixture.historical_pr) || Number(fixture.historical_pr) <= 0) {
    throw new Error('BEHAVIORAL_CHECKSUM_FIXTURE_PR_INVALID');
  }
  for (const field of [
    'task_id',
    'source_path',
    'base_producer',
    'candidate_producer',
    'consumer',
    'authoritative_claim',
    'narrowed_from',
    'residual_judgment',
  ] as const) {
    requireString(fixture[field], field);
  }
  for (const field of [
    'base_revision',
    'candidate_revision',
    'base_blob_sha',
    'candidate_blob_sha',
  ] as const) {
    requireSha(fixture[field], field);
  }
  if (
    typeof fixture.expected !== 'object' ||
    fixture.expected === null ||
    Array.isArray(fixture.expected)
  ) {
    throw new Error('BEHAVIORAL_CHECKSUM_EXPECTED_INVALID');
  }
  const expected = fixture.expected as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(expected).sort()) !==
    JSON.stringify(
      ['base_after_relocation', 'candidate_after_relocation', 'candidate_after_tamper'].sort(),
    )
  ) {
    throw new Error('BEHAVIORAL_CHECKSUM_EXPECTED_KEYS_INVALID');
  }
  for (const value of Object.values(expected)) {
    if (value !== 'pass' && value !== 'fail') {
      throw new Error('BEHAVIORAL_CHECKSUM_EXPECTED_STATE_INVALID');
    }
  }
  return structuredClone(value) as BehavioralChecksumFixture;
}

function runShell(cwd: string, command: string): number {
  return (
    spawnSync('bash', ['-ceu', command], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    }).status ?? 1
  );
}

function runRelocationScenario(
  producer: string,
  consumer: string,
  { tamper = false }: { tamper?: boolean } = {},
): ExpectedState {
  const buildRoot = mkdtempSync(join(tmpdir(), 'overcenter-checksum-build-'));
  const downloadRoot = mkdtempSync(join(tmpdir(), 'overcenter-checksum-download-'));
  try {
    const buildArtifact = join(buildRoot, 'worker-client');
    mkdirSync(buildArtifact, { recursive: true });
    writeFileSync(join(buildArtifact, 'overcenter'), Buffer.from('portable-worker-client\n'));

    if (runShell(buildRoot, producer) !== 0) {
      throw new Error('BEHAVIORAL_CHECKSUM_PRODUCER_FAILED');
    }

    const downloadedArtifact = join(downloadRoot, 'worker-client');
    cpSync(buildArtifact, downloadedArtifact, { recursive: true });
    if (tamper) {
      writeFileSync(
        join(downloadedArtifact, 'overcenter'),
        Buffer.from('tampered-worker-client\n'),
      );
    }

    return runShell(downloadRoot, consumer) === 0 ? 'pass' : 'fail';
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(downloadRoot, { recursive: true, force: true });
  }
}

export function executeBehavioralChecksumOracle(
  fixtureValue: unknown,
  fixtureBytes?: string,
): BehavioralChecksumOracleResult {
  const fixture = validateBehavioralChecksumFixture(fixtureValue);
  const scenarios = {
    base_after_relocation: runRelocationScenario(fixture.base_producer, fixture.consumer),
    candidate_after_relocation: runRelocationScenario(fixture.candidate_producer, fixture.consumer),
    candidate_after_tamper: runRelocationScenario(fixture.candidate_producer, fixture.consumer, {
      tamper: true,
    }),
  } satisfies BehavioralChecksumOracleResult['scenarios'];

  for (const [name, expected] of Object.entries(fixture.expected)) {
    const actual = scenarios[name as keyof typeof scenarios];
    if (actual !== expected) {
      throw new Error(`BEHAVIORAL_CHECKSUM_ORACLE_MISMATCH:${name}:${actual}:${expected}`);
    }
  }

  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return {
    schema: 'overcenter-semantic-scaling-behavioral-oracle-result/v1',
    source_revision: sourceRevision,
    fixture_sha256: createHash('sha256')
      .update(fixtureBytes ?? JSON.stringify(fixture))
      .digest('hex'),
    task_id: fixture.task_id,
    classification: 'frontier-limited',
    authoritative_claim: fixture.authoritative_claim,
    narrowed_from: fixture.narrowed_from,
    residual_judgment: fixture.residual_judgment,
    historical_identity: {
      base_revision: fixture.base_revision,
      candidate_revision: fixture.candidate_revision,
      source_path: fixture.source_path,
      base_blob_sha: fixture.base_blob_sha,
      candidate_blob_sha: fixture.candidate_blob_sha,
    },
    scenarios,
  };
}

function main(): void {
  const fixturePath =
    process.argv[2] ?? 'experiments/semantic-scaling/behavioral-checksum.fixture.json';
  const fixtureBytes = readFileSync(fixturePath, 'utf8');
  const result = executeBehavioralChecksumOracle(JSON.parse(fixtureBytes), fixtureBytes);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('behavioral-checksum-oracle.ts')) main();
