import { spawn } from 'node:child_process';
import { appendFile, chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectHatchableRemoteMcp } from './exact-revision-v8-verification-http.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const EXPIRY_RESERVE_MS = 2 * 60 * 1000;
const GIT_DIFF_LABEL = 'git diff';

function reject(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) reject('CODEX_EXECUTOR_CONFIGURATION_REQUIRED', `${name} is required`, { field: name });
  return normalized;
}

function safeJsonParse(text, code, message) {
  try { return JSON.parse(text); }
  catch { reject(code, message); }
}

function validateExecutionIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) reject('CODEX_EXECUTION_INTENT_REQUIRED', 'execution_intent is required');
  if (intent.schema !== 'project-execution-intent-v1') reject('CODEX_EXECUTION_INTENT_INVALID', 'execution_intent schema is unsupported');
  const desiredOutcome = String(intent.desired_outcome || '').trim();
  if (!desiredOutcome || desiredOutcome.length > 4096) reject('CODEX_EXECUTION_INTENT_INVALID', 'execution_intent.desired_outcome is invalid');
  if (!Array.isArray(intent.acceptance_evidence) || intent.acceptance_evidence.length < 1 || intent.acceptance_evidence.length > 16) {
    reject('CODEX_EXECUTION_INTENT_INVALID', 'execution_intent.acceptance_evidence must contain 1 to 16 requirements');
  }
  const acceptanceEvidence = intent.acceptance_evidence.map((entry, index) => {
    const kind = String(entry?.kind || '').trim();
    const requirement = String(entry?.requirement || '').trim();
    if (!kind || kind.length > 128 || !requirement || requirement.length > 2048) {
      reject('CODEX_EXECUTION_INTENT_INVALID', `execution_intent.acceptance_evidence[${index}] is invalid`);
    }
    return { kind, requirement };
  });
  return {
    schema: 'project-execution-intent-v1',
    desired_outcome: desiredOutcome,
    acceptance_evidence: acceptanceEvidence,
    ...(intent.source_ref ? { source_ref: String(intent.source_ref).trim() } : {}),
  };
}

function normalizePacket(body, repository, transitionId) {
  if (body?.outcome !== 'AGENT_EXECUTION_REQUIRED') reject('CODEX_EXECUTION_NOT_REQUIRED', 'project.advance did not return AGENT_EXECUTION_REQUIRED', { outcome: body?.outcome ?? null });
  if (body?.authority?.kind !== 'github' || body.authority.repository !== repository) reject('CODEX_AUTHORITY_MISMATCH', 'project.advance returned incompatible GitHub authority');
  const revision = String(body.authority.revision || '').toLowerCase();
  if (!SHA40.test(revision)) reject('CODEX_AUTHORITY_MISMATCH', 'project.advance authority revision is not an exact Git SHA');
  if (body?.transition?.id !== transitionId) reject('CODEX_TRANSITION_MISMATCH', 'project.advance returned another transition');
  const leaseRef = required(body.lease_ref, 'project.advance lease_ref');
  const runId = required(body.run_id, 'project.advance run_id');
  const expiresAt = required(body.expires_at, 'project.advance expires_at');
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() + EXPIRY_RESERVE_MS) reject('CODEX_LEASE_WINDOW_TOO_SHORT', 'project.advance lease does not leave enough execution time');
  const executionIntent = validateExecutionIntent(body.transition.execution_intent);
  const transitionDefinitionFingerprint = String(body.transition_definition_fingerprint || '').trim().toLowerCase();
  if (!SHA256.test(transitionDefinitionFingerprint)) reject('CODEX_TRANSITION_FINGERPRINT_REQUIRED', 'project.advance transition fingerprint is missing or invalid');
  return Object.freeze({
    schema: 'overcenter-codex-execution-packet-v1',
    project_ref: `github:${repository}`,
    repository,
    transition_id: transitionId,
    run_id: runId,
    lease_ref: leaseRef,
    expires_at: expiresAt,
    transition_definition_fingerprint: transitionDefinitionFingerprint,
    authority: Object.freeze({ kind: 'github', repository, revision, derivation: String(body.authority.derivation || '') }),
    execution_intent: executionIntent,
  });
}

function promptFor(packet) {
  const requirements = packet.execution_intent.acceptance_evidence
    .map((entry, index) => `${index + 1}. [${entry.kind}] ${entry.requirement}`)
    .join('\n');
  return `You are a disposable implementation agent executing one authority-bound Overcenter packet.\n\nRepository: ${packet.repository}\nExact source revision: ${packet.authority.revision}\nTransition: ${packet.transition_id}\n\nDesired outcome:\n${packet.execution_intent.desired_outcome}\n\nAcceptance evidence required:\n${requirements}\n\nExecution rules:\n- Treat this packet and the checked-out repository as the complete task context. Do not reconstruct intent from prior conversations.\n- Work only inside the provided checkout. Do not commit, push, open pull requests, settle work, or mutate remote services.\n- Do not use GitHub, Hatchable, or OpenAI API credentials. Deterministic software owns external mutation and settlement.\n- Inspect the repository, make the smallest safe changes needed, and run relevant verification.\n- If the desired outcome cannot be completed from this packet and checkout alone, return status \"blocked\" and explain the missing authority or information.\n- Your final response must conform exactly to the supplied JSON schema. Evidence entries should name concrete tests, checks, or blocking facts.\n`;
}

async function appendGithubOutput(entries) {
  const output = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!output) return;
  await appendFile(output, Object.entries(entries).map(([key, value]) => `${key}=${String(value)}\n`).join(''));
}

async function runOvercenter(connection, projectId, command, input) {
  const response = await connection.callTool('run_function', {
    project_id: projectId,
    path: '/api/worker-command',
    method: 'POST',
    body: { command, input },
  });
  const status = Number(response?.status ?? response?.result?.status ?? 0);
  const body = response?.body ?? response?.result?.body ?? response;
  if (status !== 200 || body?.ok !== true) {
    reject('OVERCENTER_COMMAND_FAILED', `${command} failed`, { status, body });
  }
  return body;
}

function codexChildEnvironment() {
  const inheritedEnvironmentKeys = [
    'PATH', 'HOME', 'USERPROFILE', 'CODEX_HOME',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  ];
  const childEnv = Object.fromEntries(inheritedEnvironmentKeys
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]]));
  childEnv.CI = 'true';
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.CODEX_API_KEY;
  delete childEnv.HATCHABLE_TOKEN;
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GH_TOKEN;
  return childEnv;
}

function spawnCodex(args, options = {}) {
  const windows = process.platform === 'win32';
  return spawn('codex', args, { ...options, shell: windows });
}

async function captureCodex(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnCodex(args, { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => rejectPromise(error));
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

function validateCodexResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) reject('CODEX_RESULT_INVALID', 'Codex result must be an object');
  const keys = Object.keys(result).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['evidence', 'status', 'summary'])) reject('CODEX_RESULT_INVALID', 'Codex result contains unsupported fields');
  if (!['completed', 'blocked'].includes(result.status)) reject('CODEX_RESULT_INVALID', 'Codex result status is invalid');
  const summary = String(result.summary || '').trim();
  if (!summary || summary.length > 4096) reject('CODEX_RESULT_INVALID', 'Codex result summary is invalid');
  if (!Array.isArray(result.evidence) || result.evidence.length > 32) reject('CODEX_RESULT_INVALID', 'Codex result evidence is invalid');
  const evidence = result.evidence.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['detail', 'kind'])) {
      reject('CODEX_RESULT_INVALID', `Codex evidence[${index}] has an invalid shape`);
    }
    const kind = String(entry.kind || '').trim();
    const detail = String(entry.detail || '').trim();
    if (!kind || kind.length > 128 || !detail || detail.length > 2048) reject('CODEX_RESULT_INVALID', `Codex evidence[${index}] is invalid`);
    return { kind, detail };
  });
  if (result.status === 'completed' && evidence.length === 0) reject('CODEX_RESULT_INVALID', 'Completed Codex work must provide evidence');
  return { status: result.status, summary, evidence };
}

async function runGit(workspace, args, encoding = 'utf8') {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', code => {
      if (code !== 0) return rejectPromise(Object.assign(new Error(`${GIT_DIFF_LABEL} helper failed: ${stderr.trim()}`), { code: 'CODEX_GIT_FAILED' }));
      const buffer = Buffer.concat(stdout);
      resolvePromise(encoding === null ? buffer : buffer.toString(encoding));
    });
  });
}

function safeWorkspacePath(workspace, repoPath) {
  const normalized = String(repoPath || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) reject('CODEX_CHANGESET_PATH_INVALID', 'Codex produced an unsafe repository path', { path: repoPath });
  const absolute = resolve(workspace, ...normalized.split('/'));
  const root = resolve(workspace);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) reject('CODEX_CHANGESET_PATH_INVALID', 'Codex path escapes the workspace', { path: repoPath });
  return { path: normalized, absolute };
}

async function fileChange(workspace, repoPath, tracked) {
  const safe = safeWorkspacePath(workspace, repoPath);
  let fileStat;
  try { fileStat = await lstat(safe.absolute); }
  catch (error) {
    if (error?.code === 'ENOENT' && tracked) return { path: safe.path, operation: 'delete' };
    throw error;
  }
  if (!fileStat.isFile()) reject('CODEX_CHANGESET_FILE_REQUIRED', 'Codex changes must be ordinary files', { path: safe.path });
  if (fileStat.size > MAX_FILE_BYTES) reject('CODEX_CHANGESET_TOO_LARGE', 'Codex changed file exceeds the per-file bound', { path: safe.path, size: fileStat.size });
  const content = await readFile(safe.absolute);
  if (content.includes(0)) reject('CODEX_CHANGESET_TEXT_REQUIRED', 'Codex changes must be UTF-8 text', { path: safe.path });
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
  catch { reject('CODEX_CHANGESET_TEXT_REQUIRED', 'Codex changes must be UTF-8 text', { path: safe.path }); }
  return { path: safe.path, operation: tracked ? 'update' : 'create', content: text, bytes: content.length };
}

async function collectChanges(workspace) {
  const summary = await runGit(workspace, ['diff', '--no-renames', '--summary', 'HEAD', '--']);
  if (/mode change/.test(summary)) reject('CODEX_CHANGESET_MODE_UNSUPPORTED', 'Codex produced a file-mode change that the lease-scoped text changeset cannot represent');
  const trackedRaw = await runGit(workspace, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--']);
  const untrackedRaw = await runGit(workspace, ['ls-files', '--others', '--exclude-standard', '-z']);
  const tracked = trackedRaw.split('\0').filter(Boolean);
  const untracked = untrackedRaw.split('\0').filter(Boolean);
  const paths = [...new Set([...tracked, ...untracked])].sort();
  if (paths.length === 0) reject('CODEX_CHANGESET_EMPTY', 'Codex reported completion but produced no repository changes');
  if (paths.length > MAX_FILES) reject('CODEX_CHANGESET_TOO_LARGE', 'Codex changeset exceeds the file-count bound', { files: paths.length });
  const untrackedSet = new Set(untracked);
  const changes = [];
  let totalBytes = 0;
  for (const path of paths) {
    const change = await fileChange(workspace, path, !untrackedSet.has(path));
    totalBytes += Number(change.bytes || 0);
    if (totalBytes > MAX_TOTAL_BYTES) reject('CODEX_CHANGESET_TOO_LARGE', 'Codex changeset exceeds the total text bound', { total_bytes: totalBytes });
    delete change.bytes;
    changes.push(change);
  }
  return changes;
}

async function prepare(env = process.env) {
  const token = required(env.HATCHABLE_TOKEN, 'HATCHABLE_TOKEN');
  const projectId = required(env.OVERCENTER_HATCHABLE_PRODUCTION_PROJECT, 'OVERCENTER_HATCHABLE_PRODUCTION_PROJECT');
  const repository = required(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const transitionId = required(env.CODEX_TRANSITION_ID, 'CODEX_TRANSITION_ID');
  const packetPath = required(env.CODEX_PACKET_PATH, 'CODEX_PACKET_PATH');
  const promptPath = required(env.CODEX_PROMPT_PATH, 'CODEX_PROMPT_PATH');
  const connection = await connectHatchableRemoteMcp({ token });
  try {
    const body = await runOvercenter(connection, projectId, 'project.advance', { project_ref: `github:${repository}`, transition_id: transitionId });
    const packet = normalizePacket(body, repository, transitionId);
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await writeFile(promptPath, promptFor(packet), { encoding: 'utf8', mode: 0o600 });
    try { await chmod(packetPath, 0o600); await chmod(promptPath, 0o600); } catch {}
    await appendGithubOutput({ repository: packet.repository, revision: packet.authority.revision });
    process.stdout.write(`${JSON.stringify({ ok: true, outcome: body.outcome, transition_id: packet.transition_id, revision: packet.authority.revision, expires_at: packet.expires_at })}\n`);
  } finally {
    await connection.close();
  }
}

async function execute(env = process.env) {
  const packetPath = required(env.CODEX_PACKET_PATH, 'CODEX_PACKET_PATH');
  const promptPath = required(env.CODEX_PROMPT_PATH, 'CODEX_PROMPT_PATH');
  const resultPath = required(env.CODEX_RESULT_PATH, 'CODEX_RESULT_PATH');
  const eventsPath = required(env.CODEX_EVENTS_PATH, 'CODEX_EVENTS_PATH');
  const schemaPath = required(env.CODEX_RESULT_SCHEMA, 'CODEX_RESULT_SCHEMA');
  const workspace = required(env.CODEX_WORKSPACE, 'CODEX_WORKSPACE');
  const packet = safeJsonParse(await readFile(packetPath, 'utf8'), 'CODEX_PACKET_INVALID', 'Codex packet is not valid JSON');
  const head = String(await runGit(workspace, ['rev-parse', 'HEAD'])).trim().toLowerCase();
  if (head !== packet?.authority?.revision) reject('CODEX_CHECKOUT_MISMATCH', 'workspace HEAD does not equal packet authority revision', { expected: packet?.authority?.revision, actual: head });
  const expiry = Date.parse(packet.expires_at);
  const remainingMs = expiry - Date.now() - EXPIRY_RESERVE_MS;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) reject('CODEX_LEASE_WINDOW_EXPIRED', 'execution lease no longer has a safe mutation window');

  const childEnv = codexChildEnvironment();
  const login = await captureCodex(['login', 'status'], { env: childEnv, cwd: workspace });
  const loginText = `${login.stdout}\n${login.stderr}`;
  if (login.code !== 0 || !loginText.includes('Logged in using ChatGPT')) {
    reject('CODEX_CHATGPT_LOGIN_REQUIRED', 'self-hosted runner must have Codex logged in using ChatGPT, not an API key');
  }

  const prompt = await readFile(promptPath, 'utf8');
  await new Promise((resolvePromise, rejectPromise) => {
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'workspace-write', '--output-schema', schemaPath, '--output-last-message', resultPath, '--json', '-C', workspace, '-'];
    const child = spawnCodex(args, { env: childEnv, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    const eventChunks = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill(), remainingMs);
    child.stdout.on('data', chunk => eventChunks.push(Buffer.from(chunk)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', error => { clearTimeout(timer); rejectPromise(error); });
    child.on('close', async code => {
      clearTimeout(timer);
      try { await writeFile(eventsPath, Buffer.concat(eventChunks)); } catch {}
      if (code !== 0) return rejectPromise(Object.assign(new Error(`codex exec failed with exit ${code}: ${stderr.slice(-2048)}`), { code: 'CODEX_EXEC_FAILED' }));
      resolvePromise();
    });
    child.stdin.end(prompt);
  });

  const result = validateCodexResult(safeJsonParse(await readFile(resultPath, 'utf8'), 'CODEX_RESULT_INVALID', 'Codex final result is not valid JSON'));
  if (result.status === 'blocked') reject('CODEX_EXECUTION_BLOCKED', result.summary, { evidence: result.evidence });
  process.stdout.write(`${JSON.stringify({ ok: true, status: result.status, evidence_count: result.evidence.length })}\n`);
}

async function apply(env = process.env) {
  const token = required(env.HATCHABLE_TOKEN, 'HATCHABLE_TOKEN');
  const projectId = required(env.OVERCENTER_HATCHABLE_PRODUCTION_PROJECT, 'OVERCENTER_HATCHABLE_PRODUCTION_PROJECT');
  const packetPath = required(env.CODEX_PACKET_PATH, 'CODEX_PACKET_PATH');
  const resultPath = required(env.CODEX_RESULT_PATH, 'CODEX_RESULT_PATH');
  const receiptPath = required(env.CODEX_APPLY_RECEIPT_PATH, 'CODEX_APPLY_RECEIPT_PATH');
  const workspace = required(env.CODEX_WORKSPACE, 'CODEX_WORKSPACE');
  const packet = safeJsonParse(await readFile(packetPath, 'utf8'), 'CODEX_PACKET_INVALID', 'Codex packet is not valid JSON');
  const result = validateCodexResult(safeJsonParse(await readFile(resultPath, 'utf8'), 'CODEX_RESULT_INVALID', 'Codex final result is not valid JSON'));
  if (result.status !== 'completed') reject('CODEX_EXECUTION_NOT_COMPLETED', 'blocked Codex work cannot be applied');
  const head = String(await runGit(workspace, ['rev-parse', 'HEAD'])).trim().toLowerCase();
  if (head !== packet?.authority?.revision) reject('CODEX_CHECKOUT_MISMATCH', 'workspace HEAD drifted after Codex execution', { expected: packet?.authority?.revision, actual: head });
  if (Date.parse(packet.expires_at) <= Date.now() + EXPIRY_RESERVE_MS) reject('CODEX_LEASE_WINDOW_EXPIRED', 'execution lease no longer has a safe mutation window');
  const changes = await collectChanges(workspace);

  const connection = await connectHatchableRemoteMcp({ token });
  try {
    const receipt = await runOvercenter(connection, projectId, 'github.apply_changeset', {
      lease_ref: packet.lease_ref,
      changes,
      commit_message: `codex: ${packet.transition_id}`,
    });
    if (receipt?.execution_authority?.lease_ref !== packet.lease_ref || receipt?.execution_authority?.run_id !== packet.run_id) {
      reject('CODEX_APPLY_AUTHORITY_MISMATCH', 'Overcenter changeset receipt is not bound to the packet execution authority');
    }
    const boundedReceipt = {
      schema: 'overcenter-codex-apply-receipt-v1',
      run_id: packet.run_id,
      transition_id: packet.transition_id,
      authority_revision: packet.authority.revision,
      branch: receipt.branch,
      commit_sha: receipt.commit_sha,
      changed_paths: Array.isArray(receipt.changed_paths) ? receipt.changed_paths : [],
      codex_result: result,
    };
    await writeFile(receiptPath, `${JSON.stringify(boundedReceipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { await chmod(receiptPath, 0o600); } catch {}
    await appendGithubOutput({ branch: receipt.branch, commit_sha: receipt.commit_sha });
    process.stdout.write(`${JSON.stringify({ ok: true, branch: receipt.branch, commit_sha: receipt.commit_sha, changed_paths: boundedReceipt.changed_paths.length })}\n`);
  } finally {
    await connection.close();
  }
}

export { apply, collectChanges, execute, normalizePacket, prepare, validateCodexResult };

async function main() {
  const mode = String(process.argv[2] || '').trim();
  if (mode === 'prepare') return prepare();
  if (mode === 'execute') return execute();
  if (mode === 'apply') return apply();
  reject('CODEX_EXECUTOR_MODE_REQUIRED', 'expected one of: prepare, execute, apply');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error?.code || 'CODEX_AGENT_EXECUTION_FAILED', message: String(error?.message || error), details: error?.details || null })}\n`);
    process.exitCode = 1;
  });
}