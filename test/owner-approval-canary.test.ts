import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/owner-approval-canary.yml', import.meta.url),
  'utf8',
);

function job(name: string, next: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end = workflow.indexOf(`\n  ${next}:\n`, start + 1);
  assert.notEqual(start, -1, `missing job ${name}`);
  assert.notEqual(end, -1, `missing following job ${next}`);
  return workflow.slice(start, end);
}

test('owner approval canary has no automatic or pull-request trigger', () => {
  assert.match(workflow, /\non:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(workflow, /^  (push|pull_request|pull_request_target|schedule):/m);
  assert.match(workflow, /^permissions: \{\}$/m);
});

test('canary prepares and pins the owner request on main before approval', () => {
  const prepare = job('prepare', 'approval');
  assert.match(prepare, /test "\$GITHUB_EVENT_NAME" = "workflow_dispatch"/);
  assert.match(prepare, /test "\$GITHUB_ACTOR" = "\$GITHUB_REPOSITORY_OWNER"/);
  assert.match(prepare, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(prepare, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(prepare, /candidate_tree_sha/);
  assert.match(prepare, /side_effects: \[\]/);
  assert.match(prepare, /createHash\('sha256'\)/);
  assert.match(prepare, /retention-days: 90/);
});

test('only the read-only canary job enters the owner-protected environment', () => {
  const approval = job('approval', 'settle');
  assert.match(approval, /environment:\n\s+name: overcenter-owner-approval/);
  assert.match(approval, /permissions: \{\}/);
  assert.match(approval, /actions\/download-artifact@/);
  assert.match(approval, /OWNER_APPROVAL_CANARY_ARTIFACT_DIGEST_MISMATCH/);
  assert.match(approval, /manifest\.side_effects\.length !== 0/);
  assert.doesNotMatch(
    approval,
    /id-token:\s*write|contents:\s*write|deployments:\s*write|google-github-actions\/auth/,
  );
});

test('settlement records an honest no-side-effect outcome even when approval does not succeed', () => {
  const settleStart = workflow.indexOf('  settle:\n');
  assert.notEqual(settleStart, -1, 'missing settle job');
  const settle = workflow.slice(settleStart);
  assert.match(settle, /if: always\(\) && needs\.prepare\.result == 'success'/);
  assert.match(settle, /approval_job_result: process\.env\.GATE_RESULT/);
  assert.match(settle, /approval_evidence_source/);
  assert.match(settle, /classifyCanaryApproval/);
  assert.match(settle, /side_effects: \[\]/);
  assert.match(settle, /retention-days: 90/);
});
test('approval summary is rendered from the exact manifest before the environment gate', () => {
  const prepare = job('prepare', 'approval');
  assert.match(prepare, /Show the exact request before approval/);
  assert.match(prepare, /const manifest = JSON\.parse\(json\)/);
  assert.match(prepare, /const digest = createHash\('sha256'\)/);
  assert.match(prepare, /appendFileSync\([\s\S]*GITHUB_STEP_SUMMARY/);
  for (const field of [
    'Request ID',
    'Operation',
    'Repository',
    'Target ref',
    'Candidate SHA',
    'Candidate tree SHA',
    'Requested by',
    'Reason',
    'Side effects',
    'Manifest SHA-256',
  ]) {
    assert.ok(prepare.includes(field), `missing visible request field: ${field}`);
  }
  assert.doesNotMatch(prepare, /echo "- Request ID:/);
});

test('settlement reads the GitHub review decision and writes the reviewer to the receipt', () => {
  const settle = workflow.slice(workflow.indexOf('  settle:\n'));
  assert.match(settle, /actions: read/);
  assert.match(settle, /actions\/runs\/\$\{process\.env\.GITHUB_RUN_ID\}\/approvals/);
  assert.match(settle, /classifyCanaryApproval/);
  assert.match(settle, /approval_evidence_source/);
  assert.match(settle, /GITHUB_TOKEN/);
});
