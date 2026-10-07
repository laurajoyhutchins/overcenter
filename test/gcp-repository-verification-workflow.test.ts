import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const WORKFLOW = readFileSync(
  new URL('../.github/workflows/gcp-repository-verification.yml', import.meta.url),
  'utf8',
);

test('reusable verification keeps job-specific scheduling inside Overcenter', () => {
  assert.match(
    WORKFLOW,
    /runs-on: \[self-hosted, "overcenter-gcp-\$\{\{ github\.run_id \}\}-\$\{\{ inputs\.job_key \}\}-\$\{\{ github\.run_attempt \}\}"\]/,
  );
  assert.doesNotMatch(WORKFLOW, /runs-on: \[self-hosted, overcenter-gcp\]/);
});

test('called workflow checks out the caller and owns generic execution provenance', () => {
  assert.match(WORKFLOW, /name: Check out caller repository/);
  assert.match(WORKFLOW, /uses: actions\/checkout@v4/);
  assert.match(WORKFLOW, /uses: \$\/\.github\/actions\/bind-verification-identity/);
  assert.match(WORKFLOW, /uses: \$\/\.github\/actions\/record-gcp-runner-provenance/);
});

test('repository policy crosses the boundary only as an explicit command', () => {
  assert.match(
    WORKFLOW,
    /OVERCENTER_REPOSITORY_VERIFICATION_COMMAND: \$\{\{ inputs\.command \}\}/,
  );
  assert.match(
    WORKFLOW,
    /bash -ceu "\$OVERCENTER_REPOSITORY_VERIFICATION_COMMAND"/,
  );
});
