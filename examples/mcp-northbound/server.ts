import { createInterface } from 'node:readline';

const MODERN_PROTOCOL_VERSION = '2026-07-28' as const;
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion' as const;
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo' as const;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcId = string | number | null;

export interface NorthboundEvent {
  event_id: string;
  status: string;
  selected: boolean;
  blocked_reason?: string;
}

export interface NorthboundEventFrontier {
  coordinate: string;
  events: NorthboundEvent[];
  selected_event: string | null;
}

export interface NorthboundEventExplanation {
  coordinate: string;
  event_id: string;
  explanation: JsonValue;
}

export interface NorthboundEventRequest {
  event_id: string;
  coordinate: string;
}

export interface NorthboundEventRequestReceipt {
  accepted: boolean;
  event_id: string;
  coordinate: string;
  request_id?: string;
  reason?: string;
}

export interface NorthboundMcpSurface {
  listPossibleEvents(): NorthboundEventFrontier | Promise<NorthboundEventFrontier>;
  explainEvent(eventId: string): NorthboundEventExplanation | Promise<NorthboundEventExplanation>;
  requestEvent?(
    request: NorthboundEventRequest,
  ): NorthboundEventRequestReceipt | Promise<NorthboundEventRequestReceipt>;
}

export interface KernelNorthboundView {
  head(): string | null;
  inspect(): Array<{
    id: string;
    status: string;
    blocked_reason?: string;
  }>;
  deriveReadyWork(): { id: string; status: string } | null;
  explain(id: string): unknown;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

interface ServerInfo {
  name: string;
  version: string;
}

interface NorthboundMcpOptions {
  serverInfo?: ServerInfo;
}

const TOOLS = [
  {
    name: 'overcenter.query_possible_events',
    description:
      'Return the current semantic event frontier projected by Overcenter. This does not grant execution authority.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'overcenter.explain_event',
    description:
      'Explain the current Overcenter state for one semantic event without changing authority or execution state.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', minLength: 1 },
      },
      required: ['event_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'overcenter.request_event',
    description:
      'Request a semantic event at an exact coordinate. Execution is available only when a trusted host supplies an execution port.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', minLength: 1 },
        coordinate: { type: 'string', minLength: 1 },
      },
      required: ['event_id', 'coordinate'],
      additionalProperties: false,
    },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`MCP_NORTHBOUND_ARGUMENT_INVALID:${name}`);
  }
  return value;
}

function assertJsonValue(value: unknown, path = '$'): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonValue(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) throw new Error(`MCP_NORTHBOUND_NON_JSON:${path}`);
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) throw new Error(`MCP_NORTHBOUND_NON_JSON:${path}.${key}`);
    assertJsonValue(item, `${path}.${key}`);
  }
}

function findForbiddenAuthorityKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenAuthorityKey(item);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'execution_capability') return key;
    const found = findForbiddenAuthorityKey(item);
    if (found) return found;
  }
  return null;
}

function parseRequest(value: unknown): JsonRpcRequest | null {
  if (
    !isRecord(value) ||
    value.jsonrpc !== '2.0' ||
    !('id' in value) ||
    (typeof value.id !== 'string' && typeof value.id !== 'number' && value.id !== null) ||
    typeof value.method !== 'string'
  ) {
    return null;
  }
  if (value.params !== undefined && !isRecord(value.params)) return null;
  return {
    jsonrpc: '2.0',
    id: value.id,
    method: value.method,
    ...(value.params ? { params: value.params } : {}),
  };
}

function protocolVersion(request: JsonRpcRequest): string | null {
  const meta = request.params?._meta;
  if (!isRecord(meta)) return null;
  const version = meta[PROTOCOL_VERSION_META_KEY];
  return typeof version === 'string' ? version : null;
}

function responseMeta(serverInfo: ServerInfo): Record<string, unknown> {
  return {
    [SERVER_INFO_META_KEY]: serverInfo,
  };
}

function completeResult(
  serverInfo: ServerInfo,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resultType: 'complete',
    ...body,
    _meta: responseMeta(serverInfo),
  };
}

function cacheableResult(
  serverInfo: ServerInfo,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return completeResult(serverInfo, {
    ...body,
    ttlMs: 0,
    cacheScope: 'private',
  });
}

function toolResult(
  serverInfo: ServerInfo,
  value: JsonValue,
  isError = false,
): Record<string, unknown> {
  return completeResult(serverInfo, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  });
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: JsonValue,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function successResponse(id: JsonRpcId, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function callArguments(request: JsonRpcRequest): Record<string, unknown> {
  const args = request.params?.arguments;
  if (args === undefined) return {};
  if (!isRecord(args)) throw new Error('MCP_NORTHBOUND_ARGUMENTS_INVALID');
  return args;
}

function toolName(request: JsonRpcRequest): string {
  return nonEmptyString(request.params?.name, 'name');
}

function asJsonValue(value: unknown): JsonValue {
  assertJsonValue(value);
  return value;
}

export function createNorthboundMcpHandler(
  surface: NorthboundMcpSurface,
  { serverInfo = { name: 'overcenter', version: '0.0.0-spike' } }: NorthboundMcpOptions = {},
): (request: unknown) => Promise<JsonRpcResponse> {
  return async (input: unknown): Promise<JsonRpcResponse> => {
    const request = parseRequest(input);
    if (!request) return errorResponse(null, -32600, 'Invalid Request');

    const version = protocolVersion(request);
    if (version !== MODERN_PROTOCOL_VERSION) {
      return errorResponse(request.id, -32022, 'Unsupported protocol version', {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
      });
    }

    if (request.method === 'server/discover') {
      return successResponse(
        request.id,
        cacheableResult(serverInfo, {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: false } },
        }),
      );
    }

    if (request.method === 'tools/list') {
      return successResponse(request.id, cacheableResult(serverInfo, { tools: TOOLS }));
    }

    if (request.method !== 'tools/call') {
      return errorResponse(request.id, -32601, 'Method not found');
    }

    const name = toolName(request);
    const args = callArguments(request);

    if (name === 'overcenter.query_possible_events') {
      const result = await surface.listPossibleEvents();
      return successResponse(request.id, toolResult(serverInfo, asJsonValue(result)));
    }

    if (name === 'overcenter.explain_event') {
      const eventId = nonEmptyString(args.event_id, 'event_id');
      const result = await surface.explainEvent(eventId);
      return successResponse(request.id, toolResult(serverInfo, asJsonValue(result)));
    }

    if (name === 'overcenter.request_event') {
      const eventId = nonEmptyString(args.event_id, 'event_id');
      const coordinate = nonEmptyString(args.coordinate, 'coordinate');
      if (!surface.requestEvent) {
        return successResponse(
          request.id,
          toolResult(
            serverInfo,
            {
              code: 'TRUSTED_EXECUTION_PORT_REQUIRED',
              event_id: eventId,
              coordinate,
            },
            true,
          ),
        );
      }
      const result = await surface.requestEvent({ event_id: eventId, coordinate });
      const forbidden = findForbiddenAuthorityKey(result);
      if (forbidden) throw new Error(`MCP_NORTHBOUND_AUTHORITY_LEAK:${forbidden}`);
      return successResponse(request.id, toolResult(serverInfo, asJsonValue(result)));
    }

    return successResponse(
      request.id,
      toolResult(
        serverInfo,
        {
          code: 'MCP_NORTHBOUND_TOOL_UNKNOWN',
          name,
        },
        true,
      ),
    );
  };
}

export function kernelNorthboundSurface(kernel: KernelNorthboundView): NorthboundMcpSurface {
  const currentCoordinate = (): string => {
    const coordinate = kernel.head();
    if (!coordinate) throw new Error('MCP_NORTHBOUND_AUTHORITY_MISSING');
    return coordinate;
  };

  return {
    listPossibleEvents: (): NorthboundEventFrontier => {
      const coordinate = currentCoordinate();
      const selected = kernel.deriveReadyWork()?.id ?? null;
      const events = kernel
        .inspect()
        .map((work): NorthboundEvent => {
          const base: NorthboundEvent = {
            event_id: work.id,
            status: work.status,
            selected: work.id === selected,
          };
          return work.blocked_reason === undefined
            ? base
            : { ...base, blocked_reason: work.blocked_reason };
        })
        .sort((left, right) => left.event_id.localeCompare(right.event_id));

      return {
        coordinate,
        events,
        selected_event: selected,
      };
    },
    explainEvent: (eventId: string): NorthboundEventExplanation => ({
      coordinate: currentCoordinate(),
      event_id: eventId,
      explanation: asJsonValue(kernel.explain(eventId)),
    }),
  };
}

export async function serveNorthboundMcpStdio(
  surface: NorthboundMcpSurface,
  options: NorthboundMcpOptions = {},
): Promise<void> {
  const handle = createNorthboundMcpHandler(surface, options);
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false,
  });

  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, 'Parse error'))}\n`);
      continue;
    }

    try {
      const response = await handle(request);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error';
      process.stdout.write(`${JSON.stringify(errorResponse(null, -32603, message))}\n`);
    }
  }
}
