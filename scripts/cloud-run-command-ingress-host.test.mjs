import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommandIngressHandler } from './cloud-run-command-ingress-host.mjs';

function parse(result) { return JSON.parse(result.bodyText); }

function base(overrides = {}) {
  return createCommandIngressHandler({
    expectedGitHubAppId:'4616688',
    targetAudience:'https://overcenter-shadow.example.run.app',
    async validateGitHubAppJwt() { return { appId:'4616688' }; },
    async mintTargetIdentityToken() { return 'gcp-token'; },
    async fetchTarget() { return new Response('{"ok":true}', { status:200, headers:{ 'content-type':'application/json' } }); },
    ...overrides,
  });
}

test('authenticated request forwards once and relays target response unchanged', async () => {
  const calls = [];
  const handler = base({
    async validateGitHubAppJwt(token) { calls.push(['validate', token]); return { appId:'4616688' }; },
    async mintTargetIdentityToken(audience) { calls.push(['mint', audience]); return 'gcp-token'; },
    async fetchTarget(url, init) {
      calls.push(['target', url, init]);
      return new Response(JSON.stringify({ ok:true, source:'gcp' }), { status:207, headers:{ 'content-type':'application/json; charset=utf-8' } });
    },
  });
  const bodyText = '{"command":"project.inspect","input":{"project_ref":"github:laurajoyhutchins/overcenter"}}';
  const result = await handler({ method:'POST', authorization:'Bearer github-jwt', bodyText });
  assert.equal(result.status, 207);
  assert.equal(result.bodyText, '{"ok":true,"source":"gcp"}');
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(calls.filter(([kind]) => kind === 'target').length, 1);
  assert.equal(calls[2][1], 'https://overcenter-shadow.example.run.app/api/worker-command');
  assert.equal(calls[2][2].headers.Authorization, 'Bearer gcp-token');
  assert.equal(calls[2][2].body, bodyText);
});

test('missing caller credential fails before target dispatch', async () => {
  let dispatched = false;
  const handler = base({ async fetchTarget() { dispatched = true; throw new Error('not expected'); } });
  const result = await handler({ method:'POST', bodyText:'{}' });
  assert.equal(result.status, 401);
  assert.equal(parse(result).may_have_mutated, false);
  assert.equal(dispatched, false);
});

test('wrong GitHub App identity fails before target dispatch', async () => {
  let dispatched = false;
  const handler = base({
    async validateGitHubAppJwt() { return { appId:'999' }; },
    async fetchTarget() { dispatched = true; throw new Error('not expected'); },
  });
  const result = await handler({ method:'POST', authorization:'Bearer jwt', bodyText:'{}' });
  assert.equal(result.status, 403);
  assert.equal(parse(result).error, 'GITHUB_APP_IDENTITY_MISMATCH');
  assert.equal(parse(result).may_have_mutated, false);
  assert.equal(dispatched, false);
});

test('target identity acquisition failure is non-mutating and does not dispatch', async () => {
  let dispatched = false;
  const handler = base({
    async mintTargetIdentityToken() { throw Object.assign(new Error('metadata unavailable'), { code:'GCP_TARGET_IDENTITY_UNAVAILABLE' }); },
    async fetchTarget() { dispatched = true; throw new Error('not expected'); },
  });
  const result = await handler({ method:'POST', authorization:'Bearer jwt', bodyText:'{}' });
  assert.equal(result.status, 503);
  assert.equal(parse(result).may_have_mutated, false);
  assert.equal(dispatched, false);
});

test('target transport loss after dispatch is indeterminate and never retried', async () => {
  let attempts = 0;
  const handler = base({
    async fetchTarget() { attempts += 1; throw new Error('connection reset'); },
  });
  const result = await handler({ method:'POST', authorization:'Bearer jwt', bodyText:'{"command":"project.advance","input":{}}' });
  const failure = parse(result);
  assert.equal(result.status, 502);
  assert.equal(failure.error, 'GCP_COMMAND_INGRESS_TRANSPORT_INDETERMINATE');
  assert.equal(failure.may_have_mutated, true);
  assert.equal(failure.retryable, false);
  assert.equal(failure.automatic_recovery_allowed, false);
  assert.equal(attempts, 1);
});
