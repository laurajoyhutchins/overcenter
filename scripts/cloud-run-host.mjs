import { semanticCommandReceiptPointer } from '../lib/semantic-command-receipts.js';

const MAX_BODY_BYTES = 1024 * 1024;
const SHA40 = /^[0-9a-f]{40}$/;
const RECEIPT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,512}$/;

function requiredText(env, name) {
  const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
  if (!value) return null;
  return value;
}

export function resolveCloudRunConfig(env = process.env) {
  const required = ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
  const missing = required.filter(name => !requiredText(env, name));
  if (missing.length) {
    throw Object.assign(new Error(`Postgres configuration is incomplete: ${missing.join(', ')}`), { code:'POSTGRES_CONFIG_REQUIRED', details:{ missing } });
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('PORT must be an integer from 1 through 65535'), { code:'HTTP_PORT_INVALID', details:{ port:env.PORT ?? null } });
  const authorityMode = requiredText(env, 'OVERCENTER_AUTHORITY_MODE') || 'shadow';
  if (!['shadow','authoritative'].includes(authorityMode)) throw Object.assign(new Error('OVERCENTER_AUTHORITY_MODE must be shadow or authoritative'), { code:'AUTHORITY_MODE_INVALID', details:{ authority_mode:authorityMode } });
  return Object.freeze({ listenHost:'0.0.0.0', port, authorityMode, postgres:Object.freeze({ host:requiredText(env,'PGHOST'), database:requiredText(env,'PGDATABASE'), user:requiredText(env,'PGUSER'), password:requiredText(env,'PGPASSWORD') }) });
}

async function readJsonBody(request) {
  const chunks=[]; let size=0;
  for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { statusCode:413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('request body must be valid JSON'), { statusCode:400 }); }
}

function writeJson(response, statusCode, value, headers = {}) {
  response.writeHead(statusCode, { 'content-type':'application/json; charset=utf-8', ...headers });
  response.end(`${JSON.stringify(value)}\n`);
}

function validateArtifact(input) {
  const sourceRevision=typeof input?.sourceRevision==='string'?input.sourceRevision.trim():'';
  const artifactDigest=typeof input?.artifactDigest==='string'?input.artifactDigest.trim():'';
  if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) throw Object.assign(new Error('sourceRevision must be a 40-character Git SHA'), {statusCode:400});
  if (!/^sha256:[0-9a-f]{64}$/i.test(artifactDigest)) throw Object.assign(new Error('artifactDigest must be sha256:<64 hex>'), {statusCode:400});
  return {sourceRevision,artifactDigest};
}

function requestHeader(request, name) {
  const lower=String(name).toLowerCase();
  const value=request?.headers?.[lower] ?? request?.headers?.[name];
  return Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim();
}
function receiptResponseHeaders(receipt) {
  return {
    'x-overcenter-receipt-ref':receipt.receipt_ref,
    'x-overcenter-receipt-sha256':receipt.receipt_sha256,
    'x-overcenter-response-sha256':receipt.response_sha256,
    'x-overcenter-source-revision':receipt.source_revision,
  };
}
function semanticReceiptUnavailable() {
  return { ok:false, error:'SEMANTIC_RECEIPT_RUNTIME_UNAVAILABLE', message:'authoritative semantic receipt runtime is unavailable', may_have_mutated:false };
}
function semanticTransportBody(receipt) {
  return { ...receipt.response, authority_receipt:semanticCommandReceiptPointer(receipt) };
}

export function createCloudRunHandler({ db, runtime, workerCommand=null, projectInspect=null, authorityProofInspect=null, semanticReceiptStore=null, sourceRevision=null, authorityMode='shadow' }) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');
  if (!runtime || typeof runtime.publishAndVerify !== 'function') throw new TypeError('runtime.publishAndVerify is required');
  if (workerCommand !== null && typeof workerCommand !== 'function') throw new TypeError('workerCommand must be a function when supplied');
  if (projectInspect !== null && typeof projectInspect !== 'function') throw new TypeError('projectInspect must be a function when supplied');
  if (authorityProofInspect !== null && typeof authorityProofInspect !== 'function') throw new TypeError('authorityProofInspect must be a function when supplied');
  if (semanticReceiptStore !== null && (!semanticReceiptStore || typeof semanticReceiptStore.read !== 'function' || typeof semanticReceiptStore.replay !== 'function' || typeof semanticReceiptStore.record !== 'function')) throw new TypeError('semanticReceiptStore must expose read, replay, and record when supplied');
  const normalizedSourceRevision=typeof sourceRevision==='string'?sourceRevision.trim().toLowerCase():'';

  return async function handle(request,response) {
    try {
      if (request.method==='GET' && request.url==='/health') { await db.query('SELECT 1 AS ok'); return writeJson(response,200,{ok:true,runtime:'portable-node-postgres',database:'ready',authority_mode:authorityMode}); }
      if (request.method==='POST' && request.url==='/runtime/publish') { const input=await readJsonBody(request); const artifact=validateArtifact(input); const expectedFence=input.expectedFence??null; const verified=await runtime.publishAndVerify(artifact,expectedFence); return writeJson(response,200,{ok:true,verified}); }
      if (request.method==='POST' && request.url==='/api/authoritative-state/project-inspect') { if(!projectInspect) return writeJson(response,503,{ok:false,error:'read-only project inspection unavailable'}); const input=await readJsonBody(request); const result=await projectInspect(input); return writeJson(response,200,{ok:true,authority_mode:authorityMode,inspection:result}); }
      if (request.method==='POST' && request.url==='/api/authoritative-state/proof-inspect') { if(!authorityProofInspect) return writeJson(response,503,{ok:false,error:'read-only authority proof inspection unavailable'}); const input=await readJsonBody(request); const result=await authorityProofInspect(input); return writeJson(response,200,{ok:true,authority_mode:authorityMode,proof:result}); }
      if (request.method==='POST' && request.url==='/api/authoritative-state/semantic-receipt') {
        if (!semanticReceiptStore) return writeJson(response,503,semanticReceiptUnavailable());
        const input=await readJsonBody(request);
        const receipt=await semanticReceiptStore.read(input);
        return writeJson(response,200,{ok:true,authority_mode:authorityMode,receipt});
      }
      if (request.method==='POST' && request.url==='/api/worker-command') {
        if (!workerCommand) return writeJson(response,503,{ok:false,error:'semantic control plane unavailable'});
        const input=await readJsonBody(request);
        if (authorityMode!=='authoritative') return writeJson(response,409,{ok:false,error:'AUTHORITY_WRITES_DISABLED',authority_mode:authorityMode,may_have_mutated:false});
        if (!semanticReceiptStore && !normalizedSourceRevision) {
          const result=await workerCommand(input);
          return writeJson(response,Number(result?.status||500),result?.body??{ok:false,error:'semantic worker returned no body'});
        }
        if (!semanticReceiptStore || !SHA40.test(normalizedSourceRevision)) return writeJson(response,503,semanticReceiptUnavailable());
        const requestId=requestHeader(request,'x-overcenter-request-id');
        const expectedHead=requestHeader(request,'x-overcenter-expected-head').toLowerCase();
        if (!RECEIPT_REQUEST_ID.test(requestId)) return writeJson(response,422,{ok:false,error:'SEMANTIC_RECEIPT_REQUEST_ID_REQUIRED',may_have_mutated:false});
        if (!SHA40.test(expectedHead)) return writeJson(response,422,{ok:false,error:'SEMANTIC_RECEIPT_EXPECTED_HEAD_REQUIRED',may_have_mutated:false});
        if (expectedHead!==normalizedSourceRevision) return writeJson(response,409,{ok:false,error:'SEMANTIC_RECEIPT_SOURCE_REVISION_MISMATCH',expected_head:expectedHead,source_revision:normalizedSourceRevision,may_have_mutated:false});
        const receiptInput={request_id:requestId,command:String(input?.command||''),source_revision:normalizedSourceRevision,request:input};
        const replay=await semanticReceiptStore.replay(receiptInput);
        if (replay?.receipt) return writeJson(response,replay.receipt.http_status,semanticTransportBody(replay.receipt),receiptResponseHeaders(replay.receipt));
        const result=await workerCommand(input);
        const recorded=await semanticReceiptStore.record({...receiptInput,response:result?.body??{ok:false,error:'semantic worker returned no body'},http_status:Number(result?.status||500)});
        return writeJson(response,recorded.receipt.http_status,semanticTransportBody(recorded.receipt),receiptResponseHeaders(recorded.receipt));
      }
      return writeJson(response,404,{ok:false,error:'not found'});
    } catch(error) {
      return writeJson(response,error.statusCode||error.httpStatus||500,{
        ok:false,
        error:error.code||error.message||'internal error',
        ...(error.message && error.code ? {message:error.message}:{}),
        ...(error.details ? {details:error.details}:{}),
        ...(typeof error.may_have_mutated==='boolean' ? {may_have_mutated:error.may_have_mutated}:{}),
      });
    }
  };
}
