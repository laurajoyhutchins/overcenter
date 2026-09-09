import assert from 'node:assert/strict';
import test from 'node:test';
import { createGcpCommandForwarder } from '../lib/gcp-command-forwarder.js';

test('forwarder requires configured ingress before dispatch', async () => {
  let dispatched = false;
  const forwarder = createGcpCommandForwarder({
    ingressUrl: '',
    async mintCallerToken() { return 'jwt'; },
    async fetchImpl() { dispatched = true; throw new Error('unexpected'); },
  });
  const result = await forwarder.execute('project.inspect', { project_ref:'github:laurajoyhutchins/overcenter' });
  assert.equal(result.error, 'GCP_COMMAND_INGRESS_SETUP_REQUIRED');
  assert.equal(result.may_have_mutated, false);
  assert.equal(result.retryable, false);
  assert.equal(dispatched, false);
});

test('forwarder mints one caller token and relays authoritative JSON unchanged', async () => {
  const calls = [];
  const forwarder = createGcpCommandForwarder({
    ingressUrl: 'https://ingress.example.run.app',
    async mintCallerToken() { calls.push(['mint']); return 'github-jwt'; },
    async fetchImpl(url, init) {
      calls.push(['fetch', url, init]);
      return new Response('{"ok":true,"source":"gcp","status":207}', { status:207, headers:{'content-type':'application/json'} });
    },
  });
  const input = { project_ref:'github:laurajoyhutchins/overcenter' };
  const result = await forwarder.execute('project.inspect', input);
  assert.deepEqual(result, { ok:true, source:'gcp', status:207 });
  assert.equal(calls.filter(([kind]) => kind === 'mint').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'fetch').length, 1);
  assert.equal(calls[1][1], 'https://ingress.example.run.app/');
  assert.equal(calls[1][2].headers.Authorization, 'Bearer github-jwt');
  assert.equal(calls[1][2].body, JSON.stringify({ command:'project.inspect', input }));
});

test('authoritative non-2xx JSON is returned without local reinterpretation', async () => {
  const upstream = { ok:false, error:'SOURCE_CONFLICT', may_have_mutated:false, retryable:false };
  const forwarder = createGcpCommandForwarder({
    ingressUrl: 'https://ingress.example.run.app',
    async mintCallerToken() { return 'jwt'; },
    async fetchImpl() { return new Response(JSON.stringify(upstream), { status:409 }); },
  });
  assert.deepEqual(await forwarder.execute('project.inspect', {}), upstream);
});

test('caller identity failure is pre-dispatch and non-mutating', async () => {
  let attempts = 0;
  const forwarder = createGcpCommandForwarder({
    ingressUrl: 'https://ingress.example.run.app',
    async mintCallerToken() { throw Object.assign(new Error('secret unavailable'), { code:'GITHUB_APP_SETUP_REQUIRED' }); },
    async fetchImpl() { attempts += 1; throw new Error('unexpected'); },
  });
  const result = await forwarder.execute('project.inspect', {});
  assert.equal(result.error, 'GITHUB_APP_SETUP_REQUIRED');
  assert.equal(result.may_have_mutated, false);
  assert.equal(result.retryable, false);
  assert.equal(attempts, 0);
});

test('transport loss after dispatch is mutation-indeterminate and never retried', async () => {
  let attempts = 0;
  const forwarder = createGcpCommandForwarder({
    ingressUrl: 'https://ingress.example.run.app',
    async mintCallerToken() { return 'jwt'; },
    async fetchImpl() { attempts += 1; throw new Error('connection reset'); },
  });
  const result = await forwarder.execute('project.advance', {});
  assert.equal(result.error, 'GCP_COMMAND_ADAPTER_TRANSPORT_INDETERMINATE');
  assert.equal(result.may_have_mutated, true);
  assert.equal(result.retryable, false);
  assert.equal(result.automatic_recovery_allowed, false);
  assert.equal(attempts, 1);
});
