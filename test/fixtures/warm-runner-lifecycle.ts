import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

const scenario = process.env.TEST_WARM_SCENARIO;
const events: string[] = [];
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
let pulls = 0;
const lease = {
  schema: 'overcenter-github-runner-execution-lease/v1',
  repository: 'laurajoyhutchins/arcata',
  repository_id: 1_402_666_660,
  owner_id: 219_002_713,
  job_id: 111_891_233_183,
  runner_label: 'overcenter-gcp-warm-123-check',
};

// Provider boundaries are simulated; the actual agent main loop and cleanup run unchanged.
globalThis.fetch = async (input) => {
  const url = String(input);
  let body: unknown = {};
  if (url.endsWith('/token')) body = { access_token: 'test-google-token' };
  else if (url.endsWith(':pull')) {
    if (pulls++ > 0) throw new Error('TEST_END_OF_DELIVERY');
    events.push('pull');
    body = {
      receivedMessages: [
        {
          ackId: 'test-ack',
          message: {
            messageId: 'test-message',
            data: Buffer.from(JSON.stringify(lease)).toString('base64'),
          },
        },
      ],
    };
  } else if (url.endsWith(':acknowledge')) events.push('ack');
  else if (url.endsWith(':access'))
    body = { payload: { data: Buffer.from(privateKey).toString('base64') } };
  else if (url.endsWith('/installation'))
    body = { id: 1, permissions: { administration: 'write', actions: 'read' } };
  else if (url.endsWith('/access_tokens')) body = { token: 'test-installation-token' };
  else if (url.includes('/actions/jobs/'))
    body = {
      id: lease.job_id,
      status: scenario?.startsWith('stale') ? 'completed' : 'queued',
      labels: ['self-hosted', lease.runner_label],
    };
  else if (url.endsWith('/generate-jitconfig')) body = { encoded_jit_config: 'test-jit' };
  else if (url.endsWith('/arcata'))
    body = { id: lease.repository_id, owner: { id: lease.owner_id }, full_name: lease.repository };
  else if (!url.endsWith(':modifyAckDeadline'))
    throw new Error('Unexpected test provider URL: ' + url);
  return new Response(JSON.stringify(body), { status: 200 });
};

Object.assign(fs, {
  mkdir: async () => {
    events.push('mkdir');
  },
  writeFile: async () => {
    events.push('write-jit');
  },
  rm: async () => {
    events.push('remove-workspace');
    if (scenario === 'workspace-failure') throw new Error('TEST_WORKSPACE_FAILURE');
  },
});
Object.assign(http, {
  request: (
    options: { method: string; path: string },
    callback: (response: EventEmitter & { statusCode: number }) => void,
  ) => {
    const request = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
    request.write = () => {};
    request.end = () => {
      setImmediate(() => {
        const method = options.method;
        events.push(method + ' ' + options.path);
        if (method === 'DELETE' && scenario === 'delete-transport-failure') {
          request.emit('error', new Error('TEST_DELETE_TRANSPORT_FAILURE'));
          return;
        }
        const response = Object.assign(new EventEmitter(), {
          statusCode:
            method === 'DELETE'
              ? scenario?.includes('delete-failure')
                ? 500
                : 204
              : method === 'GET'
                ? scenario === 'retained-container'
                  ? 200
                  : 404
                : options.path.includes('/create')
                  ? 201
                  : options.path.endsWith('/start')
                    ? scenario === 'start-failure'
                      ? 500
                      : 204
                    : 200,
        });
        callback(response);
        const body = options.path.includes('/create') ? { Id: 'container-id' } : { StatusCode: 0 };
        response.emit('data', Buffer.from(JSON.stringify(body)));
        response.emit('end');
      });
    };
    return request;
  },
});
syncBuiltinESMExports();
process.on('exit', () => console.log('TEST_EVENTS=' + JSON.stringify(events)));
