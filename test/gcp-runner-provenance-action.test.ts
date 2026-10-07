import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ACTION = resolve(
  '.github/actions/record-gcp-runner-provenance/record-gcp-runner-provenance.sh',
);

function run(env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'gcp-runner-provenance-'));
  const output = join(root, 'output');
  const summary = join(root, 'summary');
  const result = spawnSync('bash', [ACTION], {
    env: {
      ...process.env,
      ...env,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    },
    encoding: 'utf8',
  });
  return {
    result,
    output: result.status === 0 ? readFileSync(output, 'utf8') : '',
    summary: result.status === 0 ? readFileSync(summary, 'utf8') : '',
  };
}

const valid = {
  OC_RUNNER_NAME: 'overcenter-gcp-112637857225-8b4fcad8-329f-4b07-a437-ced7f658edbb',
  OC_REPOSITORY: 'laurajoyhutchins/arcata',
  OC_RUN_ID: '37573726138',
  OC_RUN_ATTEMPT: '1',
  OC_JOB: 'check',
};

test('records exact GCP runner provenance without interpreting repository policy', () => {
  const { result, output, summary } = run(valid);
  assert.equal(result.status, 0, result.stderr);
  assert.match(output, /provider=gcp/);
  assert.match(output, new RegExp(`runner_name=${valid.OC_RUNNER_NAME}`));
  assert.match(output, new RegExp(`repository=${valid.OC_REPOSITORY}`));
  assert.match(output, new RegExp(`run_id=${valid.OC_RUN_ID}`));
  assert.match(output, new RegExp(`run_attempt=${valid.OC_RUN_ATTEMPT}`));
  assert.match(output, new RegExp(`job=${valid.OC_JOB}`));
  assert.match(summary, /### Execution provenance/);
});

test('fails closed for a non-Overcenter runner', () => {
  const { result } = run({ ...valid, OC_RUNNER_NAME: 'github-hosted-123' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GCP_RUNNER_PROVENANCE_RUNNER_INVALID/);
});

test('fails closed for malformed run coordinates', () => {
  const { result } = run({ ...valid, OC_RUN_ID: 'not-a-run' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GCP_RUNNER_PROVENANCE_RUN_ID_INVALID/);
});

test('fails closed for malformed repository identity', () => {
  const { result } = run({ ...valid, OC_REPOSITORY: 'arcata' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GCP_RUNNER_PROVENANCE_REPOSITORY_INVALID/);
});
