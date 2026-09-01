import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveReleaseSemverPlan } from '../lib/release-semver-plan.js';
import { publishReleasePlan } from '../lib/release-publish-operation.js';

const projectRef = 'github:example/project';
const authority = Object.freeze({ kind:'github', repository:'example/project', revision:'a'.repeat(40), derivation:'overcenter-project-graph-v1' });
const authorityKey = `github:example/project@${authority.revision}#overcenter-project-graph-v1`;
const transitions = Object.freeze([
  Object.freeze({ id:'foundation', version_impact:Object.freeze({ level:'patch', summary:'Fix public command behavior.' }) }),
  Object.freeze({ id:'feature', version_impact:Object.freeze({ level:'minor', summary:'Add a public semantic command.' }) }),
]);

async function plan(overrides = {}) {
  return deriveReleaseSemverPlan({
    project_ref:projectRef,
    authority,
    horizon:{
      schema:'project-horizon-v1',
      kind:'release',
      ref:'next',
      authority,
      authority_key:authorityKey,
      target_node_ids:['feature'],
      scope_node_ids:['foundation','feature'],
    },
    base_release:{ version:'0.4.0', included_transition_ids:['foundation'] },
    transitions,
    ...overrides,
  });
}

function verifiedPrimitive(request) {
  return {
    ok:true,
    requested_commit_sha:request.target_sha,
    verified_commit_sha:request.target_sha,
    tag_name:request.tag_name,
    release_id:42,
    release_url:`https://github.com/example/project/releases/tag/${request.tag_name}`,
    post_state:'satisfied',
    verified:true,
    verification_result:'verified',
    idempotent_replay:false,
    may_have_mutated:false,
  };
}

test('release publish derives GitHub bookkeeping from a verified exact-revision plan', async () => {
  const releasePlan = await plan();
  const calls = [];
  const result = await publishReleasePlan({ plan:releasePlan, body:'Release notes' }, {
    resolveAuthority:async () => authority,
    readTransitions:async () => transitions,
    createRelease:async (request) => { calls.push(request); return verifiedPrimitive(request); },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    repo:'example/project',
    target_sha:authority.revision,
    tag_name:'v0.5.0',
    name:'v0.5.0',
    body:'Release notes',
    draft:false,
    prerelease:false,
    expected_state:{ tag:'absent', release:'absent' },
    idempotency_key:`release-publish:${releasePlan.fingerprint}`,
  });
  assert.deepEqual(result, {
    ok:true,
    schema:'release-publish-v1',
    project_ref:projectRef,
    version:'0.5.0',
    tag_name:'v0.5.0',
    target_sha:authority.revision,
    plan_fingerprint:releasePlan.fingerprint,
    release_id:42,
    release_url:'https://github.com/example/project/releases/tag/v0.5.0',
    verified:true,
    idempotent_replay:false,
  });
});

test('release publish rejects stale authority before the release primitive', async () => {
  const releasePlan = await plan();
  let mutations = 0;
  await assert.rejects(() => publishReleasePlan({ plan:releasePlan, body:'' }, {
    resolveAuthority:async () => ({ ...authority, revision:'b'.repeat(40) }),
    readTransitions:async () => transitions,
    createRelease:async () => { mutations += 1; return {}; },
  }), (error) => error?.code === 'RELEASE_PUBLISH_AUTHORITY_STALE');
  assert.equal(mutations, 0);
});

test('release publish rejects a tampered plan before the release primitive', async () => {
  const releasePlan = await plan();
  let mutations = 0;
  await assert.rejects(() => publishReleasePlan({ plan:{ ...releasePlan, candidate_version:'9.9.9' }, body:'' }, {
    resolveAuthority:async () => authority,
    readTransitions:async () => transitions,
    createRelease:async () => { mutations += 1; return {}; },
  }), (error) => error?.code === 'RELEASE_PUBLISH_PLAN_UNVERIFIED');
  assert.equal(mutations, 0);
});

test('release publish requires exact post-publication proof', async () => {
  const releasePlan = await plan();
  await assert.rejects(() => publishReleasePlan({ plan:releasePlan, body:'' }, {
    resolveAuthority:async () => authority,
    readTransitions:async () => transitions,
    createRelease:async (request) => ({ ...verifiedPrimitive(request), verified:false }),
  }), (error) => error?.code === 'RELEASE_PUBLISH_CONFIRMATION_UNPROVEN');
});

test('release publish refuses a no-op semantic version plan', async () => {
  const noImpactTransitions = Object.freeze([
    Object.freeze({ id:'foundation', version_impact:Object.freeze({ level:'none', summary:'No public compatibility change.' }) }),
  ]);
  const releasePlan = await deriveReleaseSemverPlan({
    project_ref:projectRef,
    authority,
    horizon:{ schema:'project-horizon-v1', kind:'release', ref:'noop', authority, authority_key:authorityKey, target_node_ids:['foundation'], scope_node_ids:['foundation'] },
    base_release:{ version:'0.4.0', included_transition_ids:[] },
    transitions:noImpactTransitions,
  });
  let mutations = 0;
  await assert.rejects(() => publishReleasePlan({ plan:releasePlan, body:'' }, {
    resolveAuthority:async () => authority,
    readTransitions:async () => noImpactTransitions,
    createRelease:async () => { mutations += 1; return {}; },
  }), (error) => error?.code === 'RELEASE_PUBLISH_NOT_REQUIRED');
  assert.equal(mutations, 0);
});
