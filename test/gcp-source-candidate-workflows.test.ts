import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CLASSIFICATION = readFileSync(
  new URL('../.github/workflows/gcp-source-candidate-classification.yml', import.meta.url),
  'utf8',
);
const RECORD = readFileSync(
  new URL('../.github/workflows/gcp-source-verification-record.yml', import.meta.url),
  'utf8',
);
const RECORD_SCRIPT = readFileSync(
  new URL('../scripts/record-source-verification.ts', import.meta.url),
  'utf8',
);

test('source candidate classification owns exact credential-free GCP transport', () => {
  assert.match(
    CLASSIFICATION,
    /runs-on: \[self-hosted, "overcenter-gcp-\$\{\{ github\.run_id \}\}-classify-\$\{\{ github\.run_attempt \}\}"\]/,
  );
  assert.match(CLASSIFICATION, /ref: \$\{\{ inputs\.candidate_sha \}\}/);
  assert.match(CLASSIFICATION, /persist-credentials: false/);
  assert.match(CLASSIFICATION, /test "\$GITHUB_SHA" = "\$CANDIDATE_SHA_INPUT"/);
  assert.match(CLASSIFICATION, /GITHUB_REF_NAME#overcenter\/candidate\//);
  assert.match(CLASSIFICATION, /Record GCP runner provenance/);
});

test('source verification recording owns runtime and authority-state mechanics', () => {
  assert.match(
    RECORD,
    /runs-on: \[self-hosted, "overcenter-gcp-\$\{\{ github\.run_id \}\}-record-\$\{\{ github\.run_attempt \}\}"\]/,
  );
  assert.match(RECORD, /ref: \$\{\{ inputs\.candidate_sha \}\}/);
  assert.match(RECORD, /persist-credentials: true/);
  assert.match(RECORD, /git fetch --no-tags origin/);
  assert.match(RECORD, /repository: laurajoyhutchins\/overcenter/);
  assert.match(RECORD, /ref: \$\{\{ inputs\.runtime_sha \}\}/);
  assert.match(RECORD, /trusted-runtime\/scripts\/record-source-verification\.ts/);
  assert.match(RECORD, /actions\/upload-artifact@v4/);
  assert.match(RECORD, /name: Source verification record/);
});

test('source record observation derives its job name from the trusted profile', () => {
  assert.match(
    RECORD_SCRIPT,
    /job\.name === plan\.verification_profile\.profile\.record_job/,
  );
  assert.doesNotMatch(
    RECORD_SCRIPT,
    /job\.name === ['"]Record source verification['"]/,
  );
});
