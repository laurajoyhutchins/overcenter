import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createCommandIngressHandler } from './cloud-run-command-ingress-host.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

export function resolveCommandIngressConfig(env = process.env) {
  const port = Number(env.PORT || 8080);
  const expectedGitHubAppId = String(env.OVERCENTER_GITHUB_APP_ID || '').trim();
  const targetAudience = String(env.OVERCENTER_TARGET_AUDIENCE || '').trim().replace(/\/$/, '');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('PORT must be a valid TCP port');
  if (!/^\d+$/.test(expectedGitHubAppId)) throw new TypeError('OVERCENTER_GITHUB_APP_ID must be numeric');
  const target = new URL(targetAudience);
  if (target.protocol !== 'https:' || target.origin !== targetAudience) throw new TypeError('OVERCENTER_TARGET_AUDIENCE must be an HTTPS service origin');
  return { port, expectedGitHubAppId, targetAudience };
}

export async function readBoundedBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw Object.assign(new Error('command ingress request body exceeds limit'), { code:'COMMAND_INGRESS_BODY_TOO_LARGE' });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createCommandIngressHttpHandler(options) {
  const handleCommand = createCommandIngressHandler(options);
  return async function httpHandler(request, response) {
    let bodyText;
    try {
      bodyText = await readBoundedBody(request);
    } catch (error) {
      const body = JSON.stringify({ ok:false, error:String(error?.code || 'COMMAND_INGRESS_REQUEST_INVALID'), may_have_mutated:false, retryable:false, automatic_recovery_allowed:false });
      response.writeHead(error?.code === 'COMMAND_INGRESS_BODY_TOO_LARGE' ? 413 : 400, { 'content-type':'application/json' });
      response.end(body);
      return;
    }
    const result = await handleCommand({
      method:request.method,
      authorization:request.headers.authorization,
      bodyText,
    });
    response.writeHead(result.status, result.headers);
    response.end(result.bodyText);
  };
}

export function startCommandIngress(env = process.env) {
  const config = resolveCommandIngressConfig(env);
  const server = createServer(createCommandIngressHttpHandler(config));
  server.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event:'command_ingress_listening', port:config.port, target_audience:config.targetAudience }));
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) startCommandIngress();
