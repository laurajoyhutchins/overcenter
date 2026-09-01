import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import './verify-orchestration-horizon-target.test.mjs';
import { runProjectHorizonTests } from '../lib/project-horizon.test.js';
import { bumpStableSemver, deriveReleaseSemverPlan } from '../lib/release-semver-plan.js';

test('project horizon semantics', async () => {
  const result = await runProjectHorizonTests();
  assert.equal(result.ok, true, JSON.stringify(result.tests.filter((entry) => !entry.ok), null, 2));
  assert.equal(result.failed, 0);
});

test('release SemVer plan subtracts the prior cohort before aggregating impact', async () => {
  const revision = 'a'.repeat(40);
  const authority = { kind:'github', repository:'example/project', revision, derivation:'overcenter-project-graph-v1' };
  const plan = await deriveReleaseSemverPlan({
    project_ref:'github:example/project',
    authority,
    horizon:{
      schema:'project-horizon-v1',
      kind:'release',
      ref:'next',
      authority,
      authority_key:`github:example/project@${revision}#overcenter-project-graph-v1`,
      target_node_ids:['feature'],
      scope_node_ids:['foundation','feature','fix'],
    },
    base_release:{ version:'0.8.4', included_transition_ids:['foundation'] },
    transitions:[
      { id:'foundation', version_impact:{ level:'major', summary:'Breaking work already shipped.' } },
      { id:'feature', version_impact:{ level:'minor', summary:'Add release-horizon inspection.' } },
      { id:'fix', version_impact:{ level:'patch', summary:'Correct release note ordering.' } },
    ],
  });

  assert.deepEqual(plan.candidate_transition_ids, ['feature','fix']);
  assert.equal(plan.aggregate_impact, 'minor');
  assert.equal(plan.candidate_version, '0.9.0');
  assert.equal(plan.breaking, false);
  assert.equal(plan.release_required, true);
  assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
});

test('release SemVer planning fails closed when new release work lacks impact authority', async () => {
  const revision = 'b'.repeat(40);
  const authority = { kind:'github', repository:'example/project', revision, derivation:'overcenter-project-graph-v1' };
  await assert.rejects(() => deriveReleaseSemverPlan({
    project_ref:'github:example/project',
    authority,
    horizon:{
      schema:'project-horizon-v1', kind:'release', ref:'next', authority,
      authority_key:`github:example/project@${revision}#overcenter-project-graph-v1`,
      target_node_ids:['feature'], scope_node_ids:['feature'],
    },
    base_release:{ version:'1.2.3', included_transition_ids:[] },
    transitions:[{ id:'feature' }],
  }), (error) => error?.code === 'RELEASE_SEMVER_IMPACT_REQUIRED');
});

test('release SemVer planning is fenced to exact horizon authority', async () => {
  const authority = { kind:'github', repository:'example/project', revision:'c'.repeat(40), derivation:'overcenter-project-graph-v1' };
  const stale = { ...authority, revision:'d'.repeat(40) };
  await assert.rejects(() => deriveReleaseSemverPlan({
    project_ref:'github:example/project',
    authority,
    horizon:{
      schema:'project-horizon-v1', kind:'release', ref:'next', authority:stale,
      authority_key:`github:example/project@${stale.revision}#overcenter-project-graph-v1`,
      target_node_ids:['feature'], scope_node_ids:['feature'],
    },
    base_release:{ version:'1.2.3', included_transition_ids:[] },
    transitions:[{ id:'feature', version_impact:{ level:'patch', summary:'Fix.' } }],
  }), (error) => error?.code === 'RELEASE_SEMVER_AUTHORITY_STALE');
});

test('stable SemVer bump policy preserves explicit pre-1.0 breaking intent without auto-promoting to 1.0', () => {
  assert.equal(bumpStableSemver('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpStableSemver('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpStableSemver('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpStableSemver('0.8.4', 'major'), '0.9.0');
  assert.equal(bumpStableSemver('0.8.4', 'none'), '0.8.4');
});

test('target architecture separates reachability discipline from post-advance proof', async () => {
  const definition = JSON.parse(await readFile(new URL('../.overcenter/definitions/target-architecture.json', import.meta.url), 'utf8'));
  const transitions = new Map(definition.transitions.map((transition) => [transition.id, transition]));
  const advance = transitions.get('expose-orchestration-advance');
  const proof = transitions.get('prove-orchestration-advance-production-reachability');
  const driver = transitions.get('add-targeted-project-driver');

  assert.ok(advance, 'target graph is missing expose-orchestration-advance');
  assert.ok(advance.requires.includes('require-production-reachability'), 'advance is not gated by pre-advance reachability verification discipline');
  assert.ok(proof, 'target graph is missing post-advance production reachability proof');
  assert.deepEqual(proof.requires, ['expose-orchestration-advance']);
  assert.ok(driver, 'target graph is missing add-targeted-project-driver');
  assert.deepEqual(driver.requires, ['prove-orchestration-advance-production-reachability']);
});
