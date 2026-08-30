import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { verifyExactRevision } from '../lib/exact-revision-verification.js';

const execFile = promisify(execFileCallback);
const SOURCE_MATERIALIZATION_RECEIPT_PATH = 'public/.overcenter/source-materialization.json';
export const HATCHABLE_TEXT_NORMALIZATION = 'hatchable-v8-text-v1';

function reject(code, message) { throw Object.assign(new Error(message), { code }); }

function isSyncableSourcePath(pathInput) {
  const path = typeof pathInput === 'string' ? pathInput : '';
  if (path === SOURCE_MATERIALIZATION_RECEIPT_PATH) return false;
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) return false;
  if (['hatchable.toml', 'package.json', 'seed.sql'].includes(path)) return true;
  if (/^migrations\/[^/]+\.sql$/.test(path)) return true;
  return /^(api|lib|mcp|pages|public)\/.+/.test(path);
}

function utf8Text(buffer, path) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { reject('SOURCE_UTF8_REQUIRED', `verification source must be UTF-8 text: ${path}`); }
}

export function canonicalizeHatchableText(contentInput) {
  return String(contentInput).replace(/[ \t\r\n\v\f]+$/u, '');
}

function sha256Text(content) {
  return createHash('sha256').update(content).digest('hex');
}

function runtimeSourceFile(file) {
  const content = canonicalizeHatchableText(file.content);
  return Object.freeze({ path:file.path, content, sha256:sha256Text(content) });
}

export function createCheckoutSourceAdapter(options = {}) {
  const cwd = options.cwd || process.cwd();
  const runGit = options.runGit || (async (args, execOptions = {}) => {
    const encoding = Object.prototype.hasOwnProperty.call(execOptions, 'encoding') ? execOptions.encoding : 'utf8';
    return (await execFile('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 })).stdout;
  });
  return {
    async observe({ repository, revision }) {
      const head = String(await runGit(['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim().toLowerCase();
      if (head !== revision) return { repository, revision: head, files: [] };
      const listed = String(await runGit(['ls-tree', '-r', '-z', '--name-only', revision], { encoding: 'utf8' }));
      const paths = listed.split('\0').filter(Boolean).filter(isSyncableSourcePath).sort();
      const files = [];
      for (const path of paths) {
        const raw = await runGit(['cat-file', 'blob', `${revision}:${path}`], { encoding: null });
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (buffer.includes(0)) reject('SOURCE_UTF8_REQUIRED', `verification source must be UTF-8 text: ${path}`);
        files.push({ path, content: utf8Text(buffer, path), sha256: createHash('sha256').update(buffer).digest('hex') });
      }
      return { repository, revision: head, files };
    },
  };
}

function manifestHash(files) {
  const records = [...files.values()].map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export function normalizeMcpToolResult(result) {
  if (result?.isError === true) {
    const message = Array.isArray(result?.content) ? result.content.map(item => item?.text || '').filter(Boolean).join('\n') : 'Hatchable MCP tool failed';
    reject('HATCHABLE_MCP_TOOL_ERROR', message || 'Hatchable MCP tool failed');
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  if (Array.isArray(result?.content)) {
    const text = result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text;
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
          try { return JSON.parse(parsed.text); } catch { return parsed; }
        }
        return parsed;
      } catch { return { text }; }
    }
  }
  if (result && typeof result === 'object' && typeof result.text === 'string') {
    try {
      const parsed = JSON.parse(result.text);
      return parsed && typeof parsed === 'object' && typeof parsed.text === 'string' ? JSON.parse(parsed.text) : parsed;
    } catch { return result; }
  }
  return result;
}

function normalizeRuntimeFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) reject('VERIFICATION_RUNTIME_INVALID_OBSERVATION', 'Hatchable file observation must be an array');
  return rawFiles
    .filter(file => !file?.virtual && isSyncableSourcePath(file?.path))
    .map(file => {
      const sha256 = String(file?.hash || file?.sha256 || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) reject('VERIFICATION_RUNTIME_INVALID_OBSERVATION', `Hatchable file hash is invalid: ${file?.path || ''}`);
      return { path: file.path, sha256 };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function createHatchableRuntimeAdapter({ callTool } = {}) {
  if (typeof callTool !== 'function') reject('VERIFICATION_RUNTIME_ADAPTER_INVALID', 'callTool is required');
  return {
    async inspect(project) {
      const info = await callTool('get_project', { project_id: project });
      const listed = await callTool('list_files', { project_id: project });
      const version = Number(info?.current_version);
      if (!Number.isSafeInteger(version) || version < 1) reject('VERIFICATION_RUNTIME_INVALID_OBSERVATION', 'Hatchable project version is invalid');
      return { project, version, files: normalizeRuntimeFiles(listed?.files) };
    },
    async reconcile({ project, revision, expected_version, writes, deletes }) {
      if (writes.length) await callTool('write_files', { project_id: project, files: writes, reason: `Exact-revision V8 verification ${revision}` });
      for (const path of deletes) await callTool('delete_file', { project_id: project, path, reason: `Remove stale source before exact-revision verification ${revision}` });
      return { expected_version };
    },
    async deploy({ project, revision, expected_version }) {
      const before = await callTool('get_project', { project_id: project });
      if (Number(before?.current_version) !== Number(expected_version)) reject('VERIFICATION_RUNTIME_VERSION_MISMATCH', 'verification runtime changed before deployment');
      await callTool('deploy', { project_id: project, intent: `Verify exact GitHub revision ${revision}`, summary: `Materialized exact GitHub revision ${revision} through ${HATCHABLE_TEXT_NORMALIZATION} into the isolated V8 verification runtime and prepared canonical regressions.` });
      const after = await callTool('get_project', { project_id: project });
      const version = Number(after?.current_version);
      if (version !== Number(expected_version) + 1) reject('DEPLOYMENT_VERSION_MISMATCH', 'verification deployment was not the immediate next version');
      return { version };
    },
    async inspectDeployment({ project, version }) {
      const deployment = await callTool('get_deployment', { project_id: project, version });
      if (Number(deployment?.version) !== Number(version)) reject('DEPLOYMENT_VERSION_MISMATCH', 'immutable deployment observation returned the wrong version');
      return { version: Number(version), files: normalizeRuntimeFiles(deployment?.files ?? deployment?.file_manifest) };
    },
    async runRegressions({ project }) {
      const response = await callTool('run_function', { project_id: project, path: '/api/verification/regressions', method: 'POST', body: {} });
      const body = response?.body ?? response?.result?.body ?? response;
      if (Number(response?.status ?? 200) !== 200 || !body || body.schema !== 'regression-verification-v1') reject('VERIFICATION_RUNTIME_INVALID_REGRESSION', 'canonical V8 regression endpoint returned an invalid result');
      return body;
    },
    async runProductionReachability({ project, repository, revision }) {
      const projectRef = `github:${repository}`;
      const transitionRef = 'require-production-reachability';
      const requestedTarget = Object.freeze({
        project_ref: projectRef,
        horizon: Object.freeze({ kind: 'transition', ref: transitionRef }),
      });
      const runId = `exact-revision-reachability-${revision}`;
      const startResponse = await callTool('run_function', {
        project_id: project,
        path: '/api/orchestration/start',
        method: 'POST',
        body: {
          run_id: runId,
          worker: 'exact-revision-verifier',
          mode: 'interactive',
          continuation_key: `exact-revision-reachability:${revision}`,
          scope: {
            project: 'Overcenter',
            repositories: [repository],
            direction: 'Verify graph reachability through real orchestration API entrypoints.',
          },
          target: requestedTarget,
          budget_seconds: 900,
          settlement_reserve_seconds: 60,
          minimum_new_gate_seconds: 60,
        },
      });
      const startBody = startResponse?.body ?? startResponse?.result?.body ?? startResponse;
      if (Number(startResponse?.status ?? startResponse?.result?.status ?? 200) !== 200 || startBody?.ok !== true) {
        reject('VERIFICATION_RUNTIME_REACHABILITY_FAILED', 'production reachability start entrypoint failed');
      }

      let horizonResponse;
      try {
        horizonResponse = await callTool('run_function', {
          project_id: project,
          path: '/api/orchestration/horizon-resolve',
          method: 'POST',
          body: { run_id: runId },
        });
      } finally {
        const finishResponse = await callTool('run_function', {
          project_id: project,
          path: '/api/orchestration/finish',
          method: 'POST',
          body: {
            run_id: runId,
            disposition: 'clean-stop',
            last_gate: 'ENABLE',
            stop_reason: 'Exact-revision production reachability probe completed.',
          },
        });
        const finishBody = finishResponse?.body ?? finishResponse?.result?.body ?? finishResponse;
        if (Number(finishResponse?.status ?? finishResponse?.result?.status ?? 200) !== 200 || finishBody?.ok !== true) {
          reject('VERIFICATION_RUNTIME_REACHABILITY_CLEANUP_FAILED', 'production reachability probe could not be terminalized');
        }
      }

      const status = Number(horizonResponse?.status ?? horizonResponse?.result?.status ?? 200);
      const body = horizonResponse?.body ?? horizonResponse?.result?.body ?? horizonResponse;
      const authority = body?.horizon?.authority;
      const target = body?.target;
      if (status === 200 && body?.ok === true && body?.schema === 'project-horizon-evaluation-v1') {
        if (
          authority?.kind !== 'github'
          || authority?.repository !== repository
          || typeof authority?.revision !== 'string'
          || !authority.revision
          || authority?.derivation !== 'overcenter-project-graph-v1'
          || target?.project_ref !== projectRef
          || target?.horizon?.kind !== 'transition'
          || target?.horizon?.ref !== transitionRef
        ) {
          reject('VERIFICATION_RUNTIME_REACHABILITY_INVALID', 'production reachability entrypoint returned incompatible graph evidence');
        }
        return Object.freeze({
          schema: 'production-reachability-evidence-v1',
          entrypoint: '/api/orchestration/horizon-resolve',
          runtime_project: project,
          runtime_revision: revision,
          graph_authority: Object.freeze({
            kind: authority.kind,
            repository: authority.repository,
            revision: authority.revision,
            derivation: authority.derivation,
          }),
          target: Object.freeze({
            project_ref: target.project_ref,
            horizon: Object.freeze({ kind: target.horizon.kind, ref: target.horizon.ref }),
          }),
        });
      }

      if (
        status === 412
        && body?.ok === false
        && body?.error === 'GITHUB_APP_SETUP_REQUIRED'
      ) {
        return Object.freeze({
          schema: 'production-reachability-evidence-v1',
          entrypoint: '/api/orchestration/horizon-resolve',
          runtime_project: project,
          runtime_revision: revision,
          boundary: Object.freeze({
            kind: 'external_dependency',
            dependency: 'github_app',
            configuration_key: 'GITHUB_APP_ID',
          }),
          target: requestedTarget,
        });
      }

      const message = String(body?.message || '');
      if (
        status === 500
        && body?.ok === false
        && body?.error === 'ORCHESTRATION_HORIZON_ERROR'
        && message.includes("Configuration value 'GITHUB_APP_ID' is declared as required but not set")
      ) {
        return Object.freeze({
          schema: 'production-reachability-evidence-v1',
          entrypoint: '/api/orchestration/horizon-resolve',
          runtime_project: project,
          runtime_revision: revision,
          boundary: Object.freeze({
            kind: 'external_dependency',
            dependency: 'github_app',
            configuration_key: 'GITHUB_APP_ID',
          }),
          target: requestedTarget,
        });
      }

      reject('VERIFICATION_RUNTIME_REACHABILITY_INVALID', 'production reachability entrypoint did not reach a recognized production graph boundary');
    },
  };
}

export function verificationInputFromEnv(env = process.env) {
  const token = String(env.HATCHABLE_TOKEN || '').trim();
  if (!token) reject('HATCHABLE_TOKEN_REQUIRED', 'HATCHABLE_TOKEN is required for exact-revision V8 verification');
  return {
    token,
    input: {
      repository: String(env.GITHUB_REPOSITORY || '').trim(),
      revision: String(env.EXACT_REVISION || env.GITHUB_SHA || '').trim().toLowerCase(),
      verification_project: String(env.OVERCENTER_HATCHABLE_VERIFICATION_PROJECT || '').trim(),
      production_project: String(env.OVERCENTER_HATCHABLE_PRODUCTION_PROJECT || '').trim(),
    },
  };
}

export async function connectHatchableMcp({ token, command = 'npx', args = ['-y', 'hatchable-mcp@latest'] } = {}) {
  if (!token) reject('HATCHABLE_TOKEN_REQUIRED', 'HATCHABLE_TOKEN is required for Hatchable MCP');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'),
    import('@modelcontextprotocol/client/stdio'),
  ]);
  const client = new Client({ name: 'overcenter-exact-revision-verifier', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, HATCHABLE_TOKEN: token }, stderr: 'inherit' });
  await client.connect(transport);
  return {
    callTool: async (name, toolArgs) => normalizeMcpToolResult(await client.callTool({ name, arguments: toolArgs })),
    close: async () => client.close(),
  };
}

export async function runVerificationCli(env = process.env) {
  const { token, input } = verificationInputFromEnv(env);
  const connection = await connectHatchableMcp({ token });
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

export async function verifyExactRevisionV8(input, adapters) {
  const repository = String(input?.repository || '').trim();
  const revision = typeof input?.revision === 'string' ? input.revision.trim().toLowerCase() : '';
  const project = String(input?.verification_project || '').trim();
  const productionProject = String(input?.production_project || '').trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) reject('INVALID_REVISION', 'revision must be a full 40-character commit SHA');
  if (!project || !productionProject) reject('VERIFICATION_RUNTIME_COORDINATE_REQUIRED', 'verification and production Hatchable project coordinates are required');
  if (project === productionProject) reject('VERIFICATION_RUNTIME_NOT_ISOLATED', 'verification runtime must be different from production');
  if (!adapters?.source || !adapters?.runtime) reject('VERIFICATION_ADAPTER_REQUIRED', 'source and runtime adapters are required');
  const source = await adapters.source.observe({repository,revision});
  const exact = verifyExactRevision({repository,revision},{repository:source.repository,revision:source.revision});
  if (!exact.ok) reject('EXACT_REVISION_MISMATCH','source adapter did not return the requested exact revision');

  const sourceFiles = new Map((source.files || []).map(file => [file.path,{path:file.path,content:file.content,sha256:file.sha256}]));
  const desiredFiles = new Map([...sourceFiles.values()].map(runtimeSourceFile).map(file => [file.path,file]));
  const current = await adapters.runtime.inspect(project);
  const runtimeFiles = new Map((current.files || []).map(file => [file.path,{path:file.path,sha256:file.sha256}]));
  const writes = [...desiredFiles.values()].filter(file => runtimeFiles.get(file.path)?.sha256 !== file.sha256).map(file => ({path:file.path,content:file.content}));
  const deletes = [...runtimeFiles.keys()].filter(path => !desiredFiles.has(path));
  let deploymentVersion = current.version;
  if (writes.length || deletes.length) {
    await adapters.runtime.reconcile({project,revision,expected_version:current.version,writes,deletes});
    const deployed=await adapters.runtime.deploy({project,revision,expected_version:current.version});
    if (deployed.version !== current.version+1) reject('DEPLOYMENT_VERSION_MISMATCH','verification deployment did not advance exactly one version');
    deploymentVersion=deployed.version;
  }
  const immutable=await adapters.runtime.inspectDeployment({project,version:deploymentVersion});
  const immutableFiles=new Map((immutable.files || []).map(file=>[file.path,{path:file.path,sha256:file.sha256}]));
  const missing=[...desiredFiles.keys()].filter(path=>!immutableFiles.has(path));
  const extra=[...immutableFiles.keys()].filter(path=>!desiredFiles.has(path));
  const changed=[...desiredFiles.keys()].filter(path=>immutableFiles.has(path)&&immutableFiles.get(path).sha256!==desiredFiles.get(path).sha256);
  if(missing.length||extra.length||changed.length) reject('SOURCE_MATERIALIZATION_MISMATCH','immutable verification deployment does not match exact source revision');
  const regression=await adapters.runtime.runRegressions({project,revision,deployment_version:deploymentVersion});
  if(!regression||regression.ok!==true||Number(regression.failed||0)!==0) reject('V8_REGRESSION_FAILED','canonical V8 regressions are not green');
  if(typeof adapters.runtime.runProductionReachability!=='function') reject('VERIFICATION_RUNTIME_REACHABILITY_UNAVAILABLE','production reachability probe is required');
  const productionReachability=await adapters.runtime.runProductionReachability({project,production_project:productionProject,repository,revision});
  if(!productionReachability||productionReachability.schema!=='production-reachability-evidence-v1'||productionReachability.runtime_project!==project||productionReachability.runtime_revision!==revision) reject('VERIFICATION_RUNTIME_REACHABILITY_INVALID','production reachability evidence is invalid');
  return {
    ok:true,
    schema:'exact-revision-verification-v1',
    repository,revision,
    regression:{
      ...regression,
      execution:{
        project,
        deployment_version:deploymentVersion,
        source_revision:revision,
        source_normalization:HATCHABLE_TEXT_NORMALIZATION,
        source_manifest_sha256:manifestHash(sourceFiles),
        runtime_manifest_sha256:manifestHash(immutableFiles),
        production_reachability:productionReachability,
      },
    },
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){runVerificationCli().then(result=>{if(result.ok!==true)process.exitCode=1;}).catch(error=>{process.stderr.write(`${JSON.stringify({ok:false,error:error?.code||'EXACT_REVISION_V8_VERIFICATION_FAILED',message:String(error?.message||error)})}\n`);process.exitCode=1;});}