import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('project.advance exposes explicit transition selection and explicit resume intent', async () => {
  const descriptor = await source('lib/semantic-command-descriptors.js');
  assert.match(descriptor, /const projectAdvanceSchema[\s\S]*transition_id/);
  assert.match(descriptor, /const projectAdvanceSchema[\s\S]*resume_run_id/);
  assert.match(descriptor, /'project\.advance':[\s\S]*session/i);
});

test('project.advance no longer reuses a project-wide active run implicitly', async () => {
  const host = await source('lib/project-advance-overcenter-host.js');
  assert.doesNotMatch(host, /WHERE continuation_key=\$1 AND target->>'project_ref'=\$2/);
  assert.match(host, /transition_id/);
  assert.match(host, /resume_run_id/);
  assert.match(host, /crypto\.randomUUID|sessionRefFactory|session_ref/);
});

test('exact transition selection uses the existing transition horizon and cannot silently widen to project scope', async () => {
  const host = await source('lib/project-advance-overcenter-host.js');
  assert.match(host, /kind\s*:\s*['"]transition['"]/);
  assert.match(host, /transition_id/);
  assert.match(host, /resolveHorizon/);
});

test('project.inspect exposes bounded frontier occupancy from durable project-transition leases', async () => {
  const host = await source('lib/project-inspect-overcenter-host.js');
  const runtime = await source('lib/project-inspect-github-runtime.js');
  assert.match(host, /occup/i);
  assert.match(runtime, /project-transition-lease-store|createProjectTransitionLeasePostgresStore/);
});