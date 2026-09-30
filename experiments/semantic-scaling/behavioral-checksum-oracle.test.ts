import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  executeBehavioralChecksumOracle,
  validateBehavioralChecksumFixture,
} from './behavioral-checksum-oracle.ts';

const fixtureBytes = readFileSync(
  new URL('./behavioral-checksum.fixture.json', import.meta.url),
  'utf8',
);
const fixture = validateBehavioralChecksumFixture(JSON.parse(fixtureBytes));

test('historical checksum repair passes only after artifact-relative production', () => {
  const result = executeBehavioralChecksumOracle(fixture, fixtureBytes);
  assert.equal(result.classification, 'frontier-limited');
  assert.deepEqual(result.scenarios, {
    base_after_relocation: 'fail',
    candidate_after_relocation: 'pass',
    candidate_after_tamper: 'fail',
  });
  assert.equal(
    result.historical_identity.base_revision,
    'e34337c90cca239ffa03f8f306c10b7e84a23483',
  );
  assert.equal(
    result.historical_identity.candidate_revision,
    'ec74e1f407b4fb3c35882ab126ad389b7cd04e87',
  );
  assert.match(result.residual_judgment, /completely captures/);
});

test('behavioral oracle rejects a plausible wrong producer that keeps build-root coordinates', () => {
  const wrong = structuredClone(fixture);
  wrong.candidate_producer = 'sha256sum worker-client/overcenter > worker-client/overcenter.sha256';
  assert.throws(
    () => executeBehavioralChecksumOracle(wrong),
    /BEHAVIORAL_CHECKSUM_ORACLE_MISMATCH:candidate_after_relocation:fail:pass/,
  );
});

test('behavioral oracle fixture vocabulary fails closed', () => {
  const invalid = structuredClone(fixture) as unknown as Record<string, unknown>;
  invalid.extra = true;
  assert.throws(
    () => validateBehavioralChecksumFixture(invalid),
    /BEHAVIORAL_CHECKSUM_FIXTURE_KEYS_INVALID/,
  );

  const staleIdentity = structuredClone(fixture) as unknown as {
    base_revision: string;
  };
  staleIdentity.base_revision = 'not-a-sha';
  assert.throws(
    () => validateBehavioralChecksumFixture(staleIdentity),
    /BEHAVIORAL_CHECKSUM_INVALID_SHA:base_revision/,
  );
});

test('broad correctness remains outside the mechanically settled claim', () => {
  assert.notEqual(fixture.authoritative_claim, fixture.narrowed_from);
  assert.ok(fixture.residual_judgment.length > 0);
});
