import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommandIngressHandler, verifyGitHubSourceRevision } from './cloud-run-command-ingress-host.mjs';

function parse(result) { return JSON.parse(result.bodyText); }
const HEAD='d36642b0f4c3c3a877415bac1614b44528bd6261';
const OTHER='8b52ce7a1554e0dac535f956fc118cc41a823a81';
const REQUEST_ID='11111111-1111-4111-8111-111111111111';

function request(overrides={}) {
  return { method:'POST', authorization:'Bearer github-jwt', expectedHead:HEAD, requestId:REQUEST_ID, bodyText:'{}', ...overrides };
}
function base(overrides = {}) {
  return createCommandIngressHandler({
    expectedGitHubAppId:'4616688',
    targetAudience:'https://overcenter-shadow.example.run.app',
    async validateGitHubAppJwt() { return { appId:'4616688' }; },
    async verifyGitHubSourceRevision(_token, expectedHead) { return { matches:expectedHead === HEAD, actualHead:HEAD }; },
    async mintTargetIdentityToken() { return 'gcp-token'; },
    async fetchTarget() { return new Response('{"ok":true}', { status:200, headers:{ 'content-type':'application/json' } }); },
    ...overrides,
  });
}

test('authenticated exact-revision request forwards once with authority and correlation headers', async () => {
  const calls = [];
  const handler = base({
    async validateGitHubAppJwt(token) { calls.push(['validate', token]); return { appId:'4616688' }; },
    async verifyGitHubSourceRevision(token, expectedHead) { calls.push(['verify', token, expectedHead]); return { matches:true, actualHead:expectedHead }; },
    async mintTargetIdentityToken(audience) { calls.push(['mint', audience]); return 'gcp-token'; },
    async fetchTarget(url, init) {
      calls.push(['target', url, init]);
      return new Response(JSON.stringify({ ok:true, source:'gcp' }), { status:207, headers:{ 'content-type':'application/json; charset=utf-8' } });
    },
  });
  const bodyText = '{"command":"project.inspect","input":{"project_ref":"github:laurajoyhutchins/overcenter"}}';
  const result = await handler(request({ bodyText }));
  assert.equal(result.status, 207);
  assert.equal(result.bodyText, '{"ok":true,"source":"gcp"}');
  assert.deepEqual(calls.slice(0,3).map(([kind])=>kind), ['validate','verify','mint']);
  assert.equal(calls[1][2], HEAD);
  assert.equal(calls[3][1], 'https://overcenter-shadow.example.run.app/api/worker-command');
  assert.equal(calls[3][2].headers.Authorization, 'Bearer gcp-token');
  assert.equal(calls[3][2].headers['x-overcenter-authority-mode'], 'authoritative');
  assert.equal(calls[3][2].headers['x-overcenter-request-id'], REQUEST_ID);
  assert.equal(calls[3][2].headers['x-overcenter-expected-head'], HEAD);
  assert.equal(calls[3][2].body, bodyText);
});

test('missing exact revision fails before target dispatch', async () => {
  let dispatched = false;
  const handler = base({ async fetchTarget() { dispatched = true; throw new Error('not expected'); } });
  const result = await handler(request({ expectedHead:'' }));
  assert.equal(result.status, 422);
  assert.equal(parse(result).error, 'COMMAND_INGRESS_EXPECTED_HEAD_REQUIRED');
  assert.equal(parse(result).may_have_mutated, false);
  assert.equal(dispatched, false);
});

test('missing request id fails before target dispatch', async () => {
  let dispatched = false;
  const handler = base({ async fetchTarget() { dispatched = true; throw new Error('not expected'); } });
  const result = await handler(request({ requestId:'' }));
  assert.equal(result.status, 422);
  assert.equal(parse(result).error, 'COMMAND_INGRESS_REQUEST_ID_REQUIRED');
  assert.equal(dispatched, false);
});

test('stale exact revision fails closed before target dispatch', async () => {
  let dispatched = false;
  const handler = base({
    async verifyGitHubSourceRevision() { return { matches:false, actualHead:OTHER }; },
    async fetchTarget() { dispatched = true; throw new Error('not expected'); },
  });
  const result = await handler(request());
  assert.equal(result.status, 409);
  assert.equal(parse(result).error, 'COMMAND_INGRESS_STALE_REVISION');
  assert.equal(parse(result).may_have_mutated, false);
  assert.equal(parse(result).details.actual_head, OTHER);
  assert.equal(dispatched, false);
});

test('source verification failure is non-mutating and does not dispatch', async () => {
  let dispatched = false;
  const handler = base({
    async verifyGitHubSourceRevision() { throw Object.assign(new Error('github down'), { code:'GITHUB_SOURCE_AUTHORITY_UNAVAILABLE' }); },
    async fetchTarget() { dispatched = true; throw new Error('not expected'); },
  });
  const result = await handler(request());
  assert.equal(result.status, 503);
  assert.equal(parse(result).may_have_mutated, false);
  assert.equal(dispatched, false);
});

test('GitHub source verifier mints installation token and reads dev ref', async () => {
  const calls=[];
  const fetchImpl=async (url, init={}) => {
    calls.push([String(url), init]);
    if (String(url).endsWith('/installation')) return new Response(JSON.stringify({id:123}), {status:200});
    if (String(url).endsWith('/access_tokens')) return new Response(JSON.stringify({token:'installation-token'}), {status:201});
    if (String(url).endsWith('/git/ref/heads/dev')) return new Response(JSON.stringify({object:{sha:HEAD}}), {status:200});
    throw new Error(`unexpected ${url}`);
  };
  const result=await verifyGitHubSourceRevision('app-jwt', HEAD, {fetchImpl});
  assert.deepEqual(result,{matches:true,actualHead:HEAD});
  assert.equal(calls.length,3);
  assert.equal(calls[0][1].headers.Authorization,'Bearer app-jwt');
  assert.equal(calls[1][0],'https://api.github.com/app/installations/123/access_tokens');
  assert.equal(calls[2][1].headers.Authorization,'Bearer installation-token');
});

test('missing caller credential fails before target dispatch', async () => {
  let dispatched = false;
  const handler = base({ async fetchTarget() { dispatched = true; throw new Error('not expected'); } });
  const result = await handler(request({ authorization:'' }));
  assert.equal(result.status, 401);
  assert.equal(parse(result).may_have_mutated, false);
  assert.equal(dispatched, false);
});

test('wrong GitHub App identity fails before source verification and target dispatch', async () => {
  let verified=false, dispatched = false;
  const handler = base({
    async validateGitHubAppJwt() { return { appId:'999' }; },
    async verifyGitHubSourceRevision() { verified=true; return {matches:true,actualHead:HEAD}; },
    async fetchTarget() { dispatched = true; throw new Error('not expected'); },
  });
  const result = await handler(request());
  assert.equal(result.status, 403);
  assert.equal(parse(result).error, 'GITHUB_APP_IDENTITY_MISMATCH');
  assert.equal(verified,false);
  assert.equal(dispatched, false);
});

test('target identity acquisition failure is non-mutating and does not dispatch', async () => {
  let dispatched = false;
  const handler = base({
    async mintTargetIdentityToken() { throw Object.assign(new Error('metadata unavailable'), { code:'GCP_TARGET_IDENTITY_UNAVAILABLE' }); },
    async fetchTarget() { dispatched = true; throw new Error('not expected'); },
  });
  const result = await handler(request());
  assert.equal(result.status, 503);
  assert.equal(parse(result).may_have_mutated, false);
  assert.equal(dispatched, false);
});

test('target transport loss after dispatch is indeterminate and never retried', async () => {
  let attempts = 0;
  const handler = base({
    async fetchTarget() { attempts += 1; throw new Error('connection reset'); },
  });
  const result = await handler(request({ bodyText:'{"command":"project.advance","input":{}}' }));
  const failure = parse(result);
  assert.equal(result.status, 502);
  assert.equal(failure.error, 'GCP_COMMAND_INGRESS_TRANSPORT_INDETERMINATE');
  assert.equal(failure.may_have_mutated, true);
  assert.equal(failure.retryable, false);
  assert.equal(failure.automatic_recovery_allowed, false);
  assert.equal(attempts, 1);
});
