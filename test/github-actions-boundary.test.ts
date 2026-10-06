import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/disposable-agent-proof.yml', import.meta.url),
  'utf8',
);
const mergeGate = readFileSync(
  new URL('../.github/workflows/merge-gate.yml', import.meta.url),
  'utf8',
);
const evidenceWorkflow = readFileSync(
  new URL('../.github/workflows/tests.yml', import.meta.url),
  'utf8',
);
const verificationProfile = JSON.parse(
  readFileSync(new URL('../.overcenter/source-verification-profile.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts?: Record<string, string> };
const projectAdvanceWorkflow = readFileSync(
  new URL('../.github/workflows/operator-project-advance.yml', import.meta.url),
  'utf8',
);
const candidateOnlyWorkflowPaths = [
  '../.github/workflows/assignment-capsule-proof.yml',
  '../.github/workflows/disposable-agent-proof.yml',
  '../.github/workflows/formal-kernel.yml',
  '../.github/workflows/github-object-transport-proof.yml',
  '../.github/workflows/production-latency.yml',
  '../.github/workflows/typebox-production-contract.yml',
];

function job(name: string, next: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end = workflow.indexOf(`\n  ${next}:\n`, start + 1);
  assert.notEqual(start, -1, `missing job ${name}`);
  assert.notEqual(end, -1, `missing following job ${next}`);
  return workflow.slice(start, end);
}

function eventBlock(source: string, event: string): string {
  const marker = `  ${event}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${event} trigger`);
  const after = source.slice(start + marker.length);
  const next = after.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/);
  return next === -1 ? after : after.slice(0, next);
}

test('GitHub Actions keeps provider write authority out of the disposable worker job', () => {
  const worker = job('agent-a', 'effect-broker');
  const broker = job('effect-broker', 'agent-b');

  assert.match(worker, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(worker, /statuses:\s*write/);
  assert.doesNotMatch(worker, /contents:\s*write/);

  assert.match(broker, /permissions:\n\s+contents: write\n\s+statuses: write\n/);
  assert.match(broker, /effect-broker\.ts/);
});

test('hosted proof does not transport worker-declared provider authority', () => {
  const worker = job('agent-a', 'effect-broker');
  const broker = job('effect-broker', 'agent-b');

  assert.doesNotMatch(
    worker,
    /effect[- ]intent|disposable-agent-effect-intent|effect-intent\.json/i,
  );
  assert.doesNotMatch(
    broker,
    /effect[- ]intent|disposable-agent-effect-intent|effect-intent\.json/i,
  );
});

test('active hosted proof contains no legacy commit-status effect intent', () => {
  const paths = [
    '../experiments/disposable-agent/authority.ts',
    '../experiments/disposable-agent/agent-a.ts',
    '../experiments/disposable-agent/effect-broker.ts',
  ];

  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /github-commit-status\/v1/);
    assert.doesNotMatch(source, /overcenter-effect-intent-v1/);
  }
});

test('intermediate PR heads cannot spend candidate-only CI evidence', () => {
  assert.match(
    eventBlock(mergeGate, 'pull_request_target'),
    /types: \[opened, synchronize, reopened\]/,
    'ordinary PR transitions must stay cheap and non-certifying',
  );
  assert.doesNotMatch(
    mergeGate,
    /github\.event_name == 'pull_request_target' && github\.event\.action == 'ready_for_review'/,
    'Ready for review must not be a merge-certification capability',
  );
  assert.match(
    mergeGate,
    /expensive: \$\{\{ github\.event_name == 'push' \|\| github\.run_attempt > 1 \}\}/,
    'only main push or an explicit rerun may spend canonical candidate evidence',
  );
  assert.doesNotMatch(
    mergeGate,
    /workflow_dispatch:/,
    'merge certification must not require a second dispatch surface',
  );
  assert.match(
    mergeGate,
    /group: merge-gate-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}/,
    'all heads for one PR must share one cancellation key while pushes remain revision-scoped',
  );
  assert.match(
    mergeGate,
    /name: \$\{\{ github\.event_name == 'pull_request_target' && github\.run_attempt == 1 && 'PR preflight' \|\| 'Merge gate' \}\}/,
    'attempt one is preflight and a rerun becomes the exact-head Merge gate',
  );
  assert.match(
    mergeGate,
    /PR preflight only; rerun Certify candidate to spend exact-head merge evidence/,
    'ordinary PR runs must expose the existing evidence job as the certification gesture',
  );
  assert.doesNotMatch(
    mergeGate,
    /pull_request_target\)[\s\S]{0,220}exit 1/,
    'ordinary PR preflight must not leave a stale failed Merge gate on the certified SHA',
  );
  assert.match(
    evidenceWorkflow,
    /workflow_call:\n\s+inputs:\n\s+expensive:/,
    'the reusable evidence workflow must accept an explicit expensive-evidence capability',
  );
  assert.match(
    evidenceWorkflow,
    /evidence:\n\s+name: Candidate evidence/,
    'merge-gate evidence must share one full runner',
  );
  assert.match(
    evidenceWorkflow,
    /runs-on: \$\{\{ fromJSON\(inputs\.expensive && '\["ubuntu-24\.04"\]' \|\| '\["ubuntu-24\.04-arm"\]'\) \}\}/,
    'cheap candidate evidence must use the public ARM64 fallback while expensive proof stays x64 hosted',
  );
  assert.match(
    mergeGate,
    /runs-on: ubuntu-24\.04-arm/,
    'merge-gate bookkeeping must use the public ARM64 fallback while GCP recovers',
  );
  for (const command of [
    'npm run proof:formal',
    'npm run proof:production-boundary',
    'scripts/proof-self-application.sh',
  ]) {
    assert.ok(evidenceWorkflow.includes(command), `candidate evidence is missing ${command}`);
  }
  assert.equal(
    Object.hasOwn(verificationProfile, 'commands'),
    false,
    'repository baseline policy must not schedule executable commands',
  );
  assert.ok(
    evidenceWorkflow.includes('verify-source-profile.ts'),
    'candidate evidence must validate the exact-base protected-input policy',
  );
  assert.doesNotMatch(
    evidenceWorkflow,
    /Run verification commands from the exact base profile/,
    'GitHub Actions must not derive executable evidence from baseline profile commands',
  );
  assert.equal(
    packageJson.scripts?.['verify:repository'],
    'npm run lint && npm run typecheck && npm run test:unit',
    'repository verification must remain a repository-owned executable contract',
  );
  assert.ok(
    evidenceWorkflow.includes('npm run verify:repository'),
    'candidate evidence must execute the substrate-neutral repository verifier',
  );
  assert.doesNotMatch(
    evidenceWorkflow,
    /test:experiments|test:experiment-contract|scripts\/experiments\.ts/,
    'candidate evidence must not depend on the archival experiment catalog or a parallel runner',
  );
  assert.doesNotMatch(
    mergeGate,
    /production-computation:|self-application:/,
    'candidate-local evidence must not acquire dedicated merge-gate runners',
  );
});

test('GitHub workflows only realize explicit neutral assurance needs', () => {
  const workflows = new URL('../.github/workflows/', import.meta.url);
  const names = new Set(readdirSync(workflows));

  assert.equal(names.has('assurance-evidence.yml'), true);
  const assurance = readFileSync(new URL('assurance-evidence.yml', workflows), 'utf8');
  assert.match(assurance, /\n  workflow_dispatch:\n/);
  assert.match(assurance, /need_json:/);
  assert.match(assurance, /runs-on: \[self-hosted, overcenter-gcp\]/);
  assert.match(assurance, /realize-assurance-evidence-need\.ts/);
  assert.doesNotMatch(assurance, /plan-assurance-evidence\.ts/);
  assert.doesNotMatch(assurance, /\n  pull_request:/);
  assert.doesNotMatch(assurance, /admit|settle|authority.*decision/i);

  for (const redundant of [
    'authority-flow-analysis.yml',
    'authority-storage-decomposition.yml',
    'computation-executor.yml',
  ]) {
    assert.equal(
      names.has(redundant),
      false,
      `${redundant} must be realized through the generic executor boundary`,
    );
  }

  const scripts = new Set(readdirSync(new URL('../scripts/', import.meta.url)));
  assert.equal(scripts.has('plan-assurance-evidence.ts'), false);
  assert.equal(scripts.has('realize-assurance-evidence-need.ts'), true);

  for (const path of [
    '../.github/workflows/distributed-authority-handoff.yml',
    '../.github/workflows/distributed-authority-chaos.yml',
    '../.github/workflows/substrate-capability-admission.yml',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /\n  workflow_call:\n/);
  }
});

test('ordinary repository PRs use a trusted base gate for control-plane changes', () => {
  assert.match(
    eventBlock(mergeGate, 'pull_request_target'),
    /types: \[opened, synchronize, reopened\]/,
    'the required merge check must execute from the trusted base workflow',
  );
  assert.doesNotMatch(
    mergeGate,
    /\n  pull_request:\n/,
    'candidate workflow bytes must not define the required merge check',
  );

  const verifier = readFileSync(
    new URL('../scripts/verify-source-profile.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    verifier,
    /path !== 'src\/source' && path !== '\.github' && path !== 'architecture'/,
    'ordinary repository PRs may change the control plane only under the trusted base gate',
  );
  assert.match(
    verifier,
    /process\.argv\.includes\('--source-candidate'\)\s*\? trusted\.profile\.protected_paths/,
    'untrusted source candidates must retain the full protected-path set',
  );
});

test('portable worker client artifact verifies after download into a fresh directory', () => {
  assert.match(
    projectAdvanceWorkflow,
    /\(cd worker-client && sha256sum overcenter > overcenter\.sha256\)/,
    'checksum paths must be relative to the artifact root',
  );
  assert.match(
    projectAdvanceWorkflow,
    /\(cd worker-client && sha256sum --check overcenter\.sha256\)/,
    'download verification must use the same artifact-relative root',
  );
});

test('standalone expensive workflows only run for candidate PR heads', () => {
  for (const path of candidateOnlyWorkflowPaths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(
      eventBlock(source, 'pull_request'),
      /types: \[ready_for_review\]/,
      `${path} must not run expensive work on synchronize`,
    );
  }
});

test('experiment workflows do not fan out on shared catalog metadata', () => {
  const workflows = new URL('../.github/workflows/', import.meta.url);
  for (const name of readdirSync(workflows).filter((entry) => entry.endsWith('.yml'))) {
    const source = readFileSync(new URL(name, workflows), 'utf8');
    if (!source.includes('  pull_request:\n')) continue;
    const pullRequest = eventBlock(source, 'pull_request');
    if (!pullRequest.includes('experiments/')) continue;

    assert.doesNotMatch(
      pullRequest,
      /experiments\/registry\.json/,
      `${name} must not treat the shared experiment registry as runtime input`,
    );
    assert.doesNotMatch(
      pullRequest,
      /experiments\/README\.md/,
      `${name} must not run for experiment index documentation`,
    );
  }
});

test('candidate handoff is transport-only and does not schedule verification', () => {
  const handoff = readFileSync(
    new URL('../.github/workflows/agent-candidate-signal.yml', import.meta.url),
    'utf8',
  );
  assert.match(handoff, /push:\n\s+branches:\n\s+- 'overcenter\/candidate\/\*\*'/);
  assert.doesNotMatch(handoff, /workflow_dispatch:/);
  assert.doesNotMatch(handoff, /source-evidence:/);
  assert.doesNotMatch(handoff, /tests\.yml/);
  assert.doesNotMatch(handoff, /accepted_baseline_sha/);
});
