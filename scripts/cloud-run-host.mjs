const MAX_BODY_BYTES = 1024 * 1024;

function requiredText(env, name) {
  const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
  if (!value) return null;
  return value;
}

export function resolveCloudRunConfig(env = process.env) {
  const required = ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
  const missing = required.filter(name => !requiredText(env, name));
  if (missing.length) {
    throw Object.assign(
      new Error(`Postgres configuration is incomplete: ${missing.join(', ')}`),
      { code: 'POSTGRES_CONFIG_REQUIRED', details: { missing } },
    );
  }

  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('PORT must be an integer from 1 through 65535'), {
      code: 'HTTP_PORT_INVALID',
      details: { port: env.PORT ?? null },
    });
  }
  const authorityMode = requiredText(env, 'OVERCENTER_AUTHORITY_MODE') || 'shadow';
  if (!['shadow', 'authoritative'].includes(authorityMode)) {
    throw Object.assign(new Error('OVERCENTER_AUTHORITY_MODE must be shadow or authoritative'), {
      code: 'AUTHORITY_MODE_INVALID',
      details: { authority_mode: authorityMode },
    });
  }

  return Object.freeze({
    listenHost: '0.0.0.0',
    port,
    authorityMode,
    postgres: Object.freeze({
      host: requiredText(env, 'PGHOST'),
      database: requiredText(env, 'PGDATABASE'),
      user: requiredText(env, 'PGUSER'),
      password: requiredText(env, 'PGPASSWORD'),
    }),
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 });
  }
}

function writeJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(value)}\n`);
}

function validateArtifact(input) {
  const sourceRevision = typeof input?.sourceRevision === 'string' ? input.sourceRevision.trim() : '';
  const artifactDigest = typeof input?.artifactDigest === 'string' ? input.artifactDigest.trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) {
    throw Object.assign(new Error('sourceRevision must be a 40-character Git SHA'), { statusCode: 400 });
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(artifactDigest)) {
    throw Object.assign(new Error('artifactDigest must be sha256:<64 hex>'), { statusCode: 400 });
  }
  return { sourceRevision, artifactDigest };
}

export function createCloudRunHandler({ db, runtime, workerCommand = null, projectInspect = null, authorityProofInspect = null, authorityMode = 'shadow' }) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');
  if (!runtime || typeof runtime.publishAndVerify !== 'function') {
    throw new TypeError('runtime.publishAndVerify is required');
  }
  if (workerCommand !== null && typeof workerCommand !== 'function') {
    throw new TypeError('workerCommand must be a function when supplied');
  }
  if (projectInspect !== null && typeof projectInspect !== 'function') {
    throw new TypeError('projectInspect must be a function when supplied');
  }
  if (authorityProofInspect !== null && typeof authorityProofInspect !== 'function') {
    throw new TypeError('authorityProofInspect must be a function when supplied');
  }

  return async function handle(request, response) {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        await db.query('SELECT 1 AS ok');
        return writeJson(response, 200, {
          ok: true,
          runtime: 'portable-node-postgres',
          database: 'ready',
          authority_mode: authorityMode,
        });
      }

      if (request.method === 'POST' && request.url === '/runtime/publish') {
        const input = await readJsonBody(request);
        const artifact = validateArtifact(input);
        const expectedFence = input.expectedFence ?? null;
        const verified = await runtime.publishAndVerify(artifact, expectedFence);
        return writeJson(response, 200, { ok: true, verified });
      }

      if (request.method === 'POST' && request.url === '/api/authoritative-state/project-inspect') {
        if (!projectInspect) return writeJson(response, 503, { ok:false, error:'read-only project inspection unavailable' });
        const input = await readJsonBody(request);
        const result = await projectInspect(input);
        return writeJson(response, 200, { ok:true, authority_mode:authorityMode, inspection:result });
      }

      if (request.method === 'POST' && request.url === '/api/authoritative-state/proof-inspect') {
        if (!authorityProofInspect) return writeJson(response, 503, { ok:false, error:'read-only authority proof inspection unavailable' });
        const input = await readJsonBody(request);
        const result = await authorityProofInspect(input);
        return writeJson(response, 200, { ok:true, authority_mode:authorityMode, proof:result });
      }

      if (request.method === 'POST' && request.url === '/api/worker-command') {
        if (!workerCommand) return writeJson(response, 503, { ok:false, error:'semantic control plane unavailable' });
        const input = await readJsonBody(request);
        if (authorityMode !== 'authoritative') {
          return writeJson(response, 409, {
            ok:false,
            error:'AUTHORITY_WRITES_DISABLED',
            authority_mode:authorityMode,
            may_have_mutated:false,
          });
        }
        const result = await workerCommand(input);
        return writeJson(response, Number(result?.status || 500), result?.body ?? { ok:false, error:'semantic worker returned no body' });
      }

      return writeJson(response, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return writeJson(response, error.statusCode || 500, {
        ok: false,
        error: error.code || error.message || 'internal error',
      });
    }
  };
}
