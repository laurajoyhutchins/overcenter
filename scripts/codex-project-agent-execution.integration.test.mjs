import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply, prepare } from './codex-project-agent-execution.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Codex prepare and apply cross the authoritative GCP command boundary with exact execution identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'overcenter-codex-gcp-integration-'));
  const workspace = join(root, 'workspace');
  const packetPath = join(root, 'packet.json');
  const promptPath = join(root, 'prompt.txt');
  const resultPath = join(root, 'result.json');
  const receiptPath = join(root, 'receipt.json');
  const repository = 'laurajoyhutchins/overcenter';
  const transitionId = 'integration-transition';
  const runId = 'integration-run';
  const leaseRef = 'integration-lease';
  const originalFetch = globalThis.fetch;
  const requests = [];
  let receiptRunId = runId;

  await mkdir(workspace, { recursive: true });
  git(workspace, 'init');
  git(workspace, 'config', 'user.name', 'Overcenter Integration Test');
  git(workspace, 'config', 'user.email', 'integration@example.invalid');
  await writeFile(join(workspace, 'fixture.txt'), 'before\n');
  git(workspace, 'add', 'fixture.txt');
  git(workspace, 'commit', '-m', 'integration fixture');
  const revision = git(workspace, 'rev-parse', 'HEAD').toLowerCase();

  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body || '{}'));
    requests.push({ url: String(url), init, body });

    assert.equal(String(url), 'https://overcenter.integration.test/api/worker-command');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer integration-token');
    assert.equal(init.headers['x-overcenter-authority-mode'], 'authoritative');

    if (body.command === 'project.advance') {
      assert.deepEqual(body.input, {
        project_ref: `github:${repository}`,
        transition_id: transitionId,
      });
      return jsonResponse({
        ok: true,
        outcome: 'AGENT_EXECUTION_REQUIRED',
        authority: {
          kind: 'github',
          repository,
          revision,
          derivation: 'integration-fixture',
        },
        transition: {
          id: transitionId,
          execution_intent: {
            schema: 'project-execution-intent-v1',
            desired_outcome: 'Change the integration fixture.',
            acceptance_evidence: [
              { kind: 'test', requirement: 'fixture.txt contains the integrated result' },
            ],
          },
        },
        lease_ref: leaseRef,
        run_id: runId,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        transition_definition_fingerprint: 'a'.repeat(64),
      });
    }

    if (body.command === 'github.apply_changeset') {
      assert.equal(body.input.lease_ref, leaseRef);
      assert.equal(body.input.commit_message, `codex: ${transitionId}`);
      assert.deepEqual(body.input.changes, [{
        path: 'fixture.txt',
        operation: 'update',
        content: 'after\n',
      }]);
      return jsonResponse({
        ok: true,
        execution_authority: { lease_ref: leaseRef, run_id: receiptRunId },
        branch: 'overcenter/integration-transition',
        commit_sha: 'b'.repeat(40),
        changed_paths: ['fixture.txt'],
      });
    }

    return jsonResponse({ ok: false, error: 'unexpected command' }, 400);
  };

  try {
    await prepare({
      GITHUB_REPOSITORY: repository,
      CODEX_TRANSITION_ID: transitionId,
      CODEX_PACKET_PATH: packetPath,
      CODEX_PROMPT_PATH: promptPath,
      OVERCENTER_SERVICE_URL: 'https://overcenter.integration.test',
      OVERCENTER_ID_TOKEN: 'integration-token',
      OVERCENTER_REQUEST_ID: 'codex:integration:prepare',
    });

    const packet = JSON.parse(await readFile(packetPath, 'utf8'));
    assert.equal(packet.authority.revision, revision);
    assert.equal(packet.run_id, runId);
    assert.equal(packet.lease_ref, leaseRef);
    assert.equal(packet.transition_definition_fingerprint, 'a'.repeat(64));
    const prompt = await readFile(promptPath, 'utf8');
    assert.match(prompt, new RegExp(`Exact source revision: ${revision}`));
    assert.match(prompt, /Change the integration fixture\./);

    await writeFile(join(workspace, 'fixture.txt'), 'after\n');
    await writeFile(resultPath, `${JSON.stringify({
      status: 'completed',
      summary: 'Updated the integration fixture.',
      evidence: [{ kind: 'test', detail: 'fixture.txt contains after' }],
    }, null, 2)}\n`);

    await apply({
      CODEX_PACKET_PATH: packetPath,
      CODEX_RESULT_PATH: resultPath,
      CODEX_APPLY_RECEIPT_PATH: receiptPath,
      CODEX_WORKSPACE: workspace,
      OVERCENTER_SERVICE_URL: 'https://overcenter.integration.test',
      OVERCENTER_ID_TOKEN: 'integration-token',
      OVERCENTER_REQUEST_ID: 'codex:integration:apply',
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].init.headers['x-overcenter-request-id'], 'codex:integration:prepare');
    assert.equal(requests[1].init.headers['x-overcenter-request-id'], 'codex:integration:apply');

    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.deepEqual(receipt, {
      schema: 'overcenter-codex-apply-receipt-v1',
      run_id: runId,
      transition_id: transitionId,
      authority_revision: revision,
      branch: 'overcenter/integration-transition',
      commit_sha: 'b'.repeat(40),
      changed_paths: ['fixture.txt'],
      codex_result: {
        status: 'completed',
        summary: 'Updated the integration fixture.',
        evidence: [{ kind: 'test', detail: 'fixture.txt contains after' }],
      },
    });
    assert.equal(receipt.lease_ref, undefined);

    receiptRunId = 'wrong-run';
    await assert.rejects(
      apply({
        CODEX_PACKET_PATH: packetPath,
        CODEX_RESULT_PATH: resultPath,
        CODEX_APPLY_RECEIPT_PATH: join(root, 'bad-receipt.json'),
        CODEX_WORKSPACE: workspace,
        OVERCENTER_SERVICE_URL: 'https://overcenter.integration.test',
        OVERCENTER_ID_TOKEN: 'integration-token',
        OVERCENTER_REQUEST_ID: 'codex:integration:apply:wrong-authority',
      }),
      error => error.code === 'CODEX_APPLY_AUTHORITY_MISMATCH',
    );
    assert.equal(requests.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
