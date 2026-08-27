import { pathToFileURL } from 'node:url';
import {
  createCheckoutSourceAdapter,
  createHatchableRuntimeAdapter,
  normalizeMcpToolResult,
  verificationInputFromEnv,
  verifyExactRevisionV8,
} from './exact-revision-v8-verification.mjs';

function reject(code, message) { throw Object.assign(new Error(message), { code }); }

export function hatchableMcpTransportConfig(token) {
  const value = String(token || '').trim();
  if (!value) reject('HATCHABLE_TOKEN_REQUIRED', 'HATCHABLE_TOKEN is required for Hatchable MCP');
  return {
    url: 'https://hatchable.com/mcp',
    requestInit: { headers: { Authorization: `Bearer ${value}` } },
  };
}

export async function connectHatchableRemoteMcp({ token } = {}) {
  const config = hatchableMcpTransportConfig(token);
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'overcenter-exact-revision-verifier', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: config.requestInit });
  await client.connect(transport);
  return {
    callTool: async (name, toolArgs) => normalizeMcpToolResult(await client.callTool({ name, arguments: toolArgs })),
    close: async () => client.close(),
  };
}

export async function runVerificationHttpCli(env = process.env) {
  const { token, input } = verificationInputFromEnv(env);
  const connection = await connectHatchableRemoteMcp({ token });
  try {
    const result = await verifyExactRevisionV8(input, {
      source: createCheckoutSourceAdapter(),
      runtime: createHatchableRuntimeAdapter({ callTool: connection.callTool }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVerificationHttpCli().then(result => { if (result.ok !== true) process.exitCode = 1; }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok:false, error:error?.code || 'EXACT_REVISION_V8_VERIFICATION_FAILED', message:String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
