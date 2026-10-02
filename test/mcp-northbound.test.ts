import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNorthboundMcpHandler,
  kernelNorthboundSurface,
  type NorthboundMcpSurface,
} from '../experiments/mcp-northbound/server.ts';

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

function request(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
} {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: MODERN_META,
    },
  };
}

test('northbound MCP advertises only the three semantic tools', async () => {
  const surface: NorthboundMcpSurface = {
    listPossibleEvents: () => ({
      coordinate: 'authority:abc',
      events: [],
      selected_event: null,
    }),
    explainEvent: () => ({
      coordinate: 'authority:abc',
      event_id: 'event:one',
      explanation: { state: 'READY' },
    }),
  };
  const handle = createNorthboundMcpHandler(surface, {
    serverInfo: { name: 'overcenter-spike', version: '0.0.0' },
  });

  const discover = await handle(request(1, 'server/discover'));
  assert.equal(discover.jsonrpc, '2.0');
  assert.equal(discover.id, 1);
  assert.deepEqual(discover.result?.supportedVersions, ['2026-07-28']);
  assert.deepEqual(discover.result?.capabilities, { tools: { listChanged: false } });
  assert.equal(discover.result?.resultType, 'complete');
  assert.equal(discover.result?.ttlMs, 0);
  assert.equal(discover.result?.cacheScope, 'private');

  const listed = await handle(request(2, 'tools/list'));
  assert.deepEqual(
    (listed.result?.tools as Array<{ name: string }>).map(({ name }) => name),
    [
      'overcenter.query_possible_events',
      'overcenter.explain_event',
      'overcenter.request_event',
    ],
  );
});

test('query and explanation are projections of the injected semantic surface', async () => {
  const surface: NorthboundMcpSurface = {
    listPossibleEvents: () => ({
      coordinate: 'authority:abc',
      events: [
        { event_id: 'event:one', status: 'READY', selected: true },
        { event_id: 'event:two', status: 'BLOCKED', selected: false },
      ],
      selected_event: 'event:one',
    }),
    explainEvent: (eventId) => ({
      coordinate: 'authority:abc',
      event_id: eventId,
      explanation: { state: eventId === 'event:one' ? 'READY' : 'BLOCKED' },
    }),
  };
  const handle = createNorthboundMcpHandler(surface);

  const queried = await handle(
    request(1, 'tools/call', {
      name: 'overcenter.query_possible_events',
      arguments: {},
    }),
  );
  assert.equal(queried.result?.resultType, 'complete');
  assert.equal(queried.result?.isError, false);
  assert.deepEqual(queried.result?.structuredContent, surface.listPossibleEvents());

  const explained = await handle(
    request(2, 'tools/call', {
      name: 'overcenter.explain_event',
      arguments: { event_id: 'event:two' },
    }),
  );
  assert.equal(explained.result?.isError, false);
  assert.deepEqual(explained.result?.structuredContent, surface.explainEvent('event:two'));
});

test('request_event stops at the trusted execution boundary by default', async () => {
  const surface: NorthboundMcpSurface = {
    listPossibleEvents: () => ({
      coordinate: 'authority:abc',
      events: [],
      selected_event: null,
    }),
    explainEvent: (eventId) => ({
      coordinate: 'authority:abc',
      event_id: eventId,
      explanation: {},
    }),
  };
  const handle = createNorthboundMcpHandler(surface);

  const result = await handle(
    request(1, 'tools/call', {
      name: 'overcenter.request_event',
      arguments: { event_id: 'event:one', coordinate: 'authority:abc' },
    }),
  );
  assert.equal(result.result?.isError, true);
  assert.deepEqual(result.result?.structuredContent, {
    code: 'TRUSTED_EXECUTION_PORT_REQUIRED',
    event_id: 'event:one',
    coordinate: 'authority:abc',
  });
});

test('request_event can delegate to a trusted port without leaking an execution capability', async () => {
  const calls: Array<{ event_id: string; coordinate: string }> = [];
  const surface: NorthboundMcpSurface = {
    listPossibleEvents: () => ({
      coordinate: 'authority:abc',
      events: [],
      selected_event: null,
    }),
    explainEvent: (eventId) => ({
      coordinate: 'authority:abc',
      event_id: eventId,
      explanation: {},
    }),
    requestEvent: (event) => {
      calls.push(event);
      return {
        accepted: true,
        event_id: event.event_id,
        coordinate: event.coordinate,
        request_id: 'request:one',
      };
    },
  };
  const handle = createNorthboundMcpHandler(surface);

  const result = await handle(
    request(1, 'tools/call', {
      name: 'overcenter.request_event',
      arguments: { event_id: 'event:one', coordinate: 'authority:abc' },
    }),
  );
  assert.deepEqual(calls, [{ event_id: 'event:one', coordinate: 'authority:abc' }]);
  assert.equal(result.result?.isError, false);
  assert.deepEqual(result.result?.structuredContent, {
    accepted: true,
    event_id: 'event:one',
    coordinate: 'authority:abc',
    request_id: 'request:one',
  });
});

test('request_event rejects authority-bearing results instead of sanitizing them', async () => {
  const surface: NorthboundMcpSurface = {
    listPossibleEvents: () => ({
      coordinate: 'authority:abc',
      events: [],
      selected_event: null,
    }),
    explainEvent: (eventId) => ({
      coordinate: 'authority:abc',
      event_id: eventId,
      explanation: {},
    }),
    requestEvent: () =>
      ({
        accepted: true,
        event_id: 'event:one',
        coordinate: 'authority:abc',
        execution_capability: 'secret',
      }) as never,
  };
  const handle = createNorthboundMcpHandler(surface);

  await assert.rejects(
    handle(
      request(1, 'tools/call', {
        name: 'overcenter.request_event',
        arguments: { event_id: 'event:one', coordinate: 'authority:abc' },
      }),
    ),
    /MCP_NORTHBOUND_AUTHORITY_LEAK:execution_capability/,
  );
});

test('kernel adapter exposes current projection and never invents an execution port', () => {
  const kernel = {
    head: () => 'authority:abc',
    inspect: () => [
      { id: 'event:one', status: 'READY' },
      { id: 'event:two', status: 'BLOCKED', blocked_reason: 'dependency' },
    ],
    deriveReadyWork: () => ({ id: 'event:one', status: 'READY' }),
    explain: (id: string) => ({ id, why: id === 'event:one' ? 'ready' : 'dependency' }),
  };

  const surface = kernelNorthboundSurface(kernel);
  assert.deepEqual(surface.listPossibleEvents(), {
    coordinate: 'authority:abc',
    events: [
      { event_id: 'event:one', status: 'READY', selected: true },
      {
        event_id: 'event:two',
        status: 'BLOCKED',
        selected: false,
        blocked_reason: 'dependency',
      },
    ],
    selected_event: 'event:one',
  });
  assert.deepEqual(surface.explainEvent('event:two'), {
    coordinate: 'authority:abc',
    event_id: 'event:two',
    explanation: { id: 'event:two', why: 'dependency' },
  });
  assert.equal(surface.requestEvent, undefined);
});
