import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const classificationUrl = new URL('../../../.contract-evidence/classifications.json', import.meta.url);
const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const runtimeRoots = ['api', 'lib', 'mcp', 'src'];
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.json']);

async function classifications() {
  return JSON.parse(await readFile(classificationUrl, 'utf8')).candidates;
}

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes:true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

async function runtimeReferences(needle) {
  const matches = [];
  for (const relativeRoot of runtimeRoots) {
    const absoluteRoot = path.join(repoRoot, relativeRoot);
    for (const file of await sourceFiles(absoluteRoot)) {
      const text = await readFile(file, 'utf8');
      if (text.includes(needle)) matches.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
    }
  }
  return matches.sort();
}

const CURRENT = Object.freeze({
  'postgres:public.github_required_check_observations#table': 'github.required-check-observation.persistence',
  'postgres:public.orchestration_horizons#table': 'orchestration.horizon.persistence',
  'postgres:public.orchestration_invocation_resolutions#table': 'orchestration.invocation-resolution.persistence',
  'postgres:public.orchestration_skill_activations#table': 'orchestration.skill-activation.persistence',
  'postgres:public.portfolio_repository_branch_roles#table': 'repository.branch-role.persistence',
  'postgres:public.portfolio_repository_disposition#table': 'repository.disposition.persistence',
  'postgres:public.portfolio_reconcile_receipts#table': 'portfolio.reconcile-receipt.persistence',
  'postgres:public.portfolio_verification_receipts#table': 'portfolio.verification-receipt.persistence',
  'postgres:public.portfolio_work_identity#table': 'repository.work-identity.persistence',
});

const COMPATIBILITY = Object.freeze({
  'postgres:public.scheduled_cycle_events#table': 'scheduler.cycle-event.persistence',
  'postgres:public.work_lease_checkpoints#table': 'compatibility.work-lease-checkpoint.persistence',
  'postgres:public.work_lease_heartbeats#table': 'compatibility.work-lease-heartbeat.persistence',
  'postgres:public.work_lease_slots#table': 'compatibility.work-lease-slot.persistence',
  'postgres:public.work_leases#table': 'compatibility.work-lease.persistence',
});

test('remaining live PostgreSQL tables declare current or compatibility lifecycle explicitly', async () => {
  const actual = await classifications();
  for (const [sourceIdentity, logicalContract] of Object.entries(CURRENT)) {
    assert.deepEqual(actual[sourceIdentity], {
      logical_contract:logicalContract,
      significance:'durable-internal',
      semver_kind:'database-layout',
      lifecycle:'current',
    }, sourceIdentity);
  }
  for (const [sourceIdentity, logicalContract] of Object.entries(COMPATIBILITY)) {
    assert.deepEqual(actual[sourceIdentity], {
      logical_contract:logicalContract,
      significance:'durable-internal',
      semver_kind:'database-layout',
      lifecycle:'compatibility',
    }, sourceIdentity);
  }
});

test('receipt tables classified as current remain backed by live runtime readers or writers', async () => {
  assert.ok((await runtimeReferences('portfolio_reconcile_receipts')).length > 0, 'portfolio_reconcile_receipts lost every runtime owner');
  assert.ok((await runtimeReferences('portfolio_verification_receipts')).length > 0, 'portfolio_verification_receipts lost every runtime owner');
});