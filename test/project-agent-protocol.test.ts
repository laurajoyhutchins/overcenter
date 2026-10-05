import { fixture, commandContext } from './support/project-agent-fixture.ts';
import { sourceProofRecord } from '../src/source/source-proof-record.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';
import {
  advanceProjectForAgent,
  submitProjectCandidate,
} from '../src/authority/project-agent-protocol.ts';
import { compileProjectIntent } from '../src/authority/project-intent.ts';
import { brokerAssignedSourceProposal } from '../src/source/source-broker.ts';
import { SOURCE_PROPOSAL_SCHEMA } from '../src/source/source-obligation.ts';
import { buildSourceTransactionPlan } from '../src/source/transaction.ts';

const AUTHORITY_REF = 'refs/overcenter/test-project-agent';
const transactionContext = {
  repository_id: 42,
  repository_full_name: 'acme/widget',
  runtime_sha: 'a'.repeat(40),
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function workerClientFixture(root: string): string {
  const path = join(root, 'native-overcenter');
  writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]));
  return path;
}

function defineAgentWork(work: string, postconditionPath: string): GitOvercenterKernel {
  const kernel = new GitOvercenterKernel(work, { remote: 'origin', ref: AUTHORITY_REF });
  kernel.initialize();
  kernel.define({
    id: 'real-frontier-work',
    packet: {
      schema: 'overcenter-agent-task/v2',
      kind: 'pure-candidate',
      command: ['node', 'task.mjs', 'input.txt', 'result.txt'],
      required_paths: ['task.mjs', 'input.txt'],
      output_path: 'result.txt',
    },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: postconditionPath,
      content: 'completed:hello\n',
    },
  });
  return kernel;
}

function commitProjectIntent(work: string, obligations: unknown[]): string {
  mkdirSync(join(work, '.overcenter'), { recursive: true });
  writeFileSync(
    join(work, '.overcenter', 'project-intent.json'),
    `${JSON.stringify({ schema: 'overcenter-project-intent/v1', obligations }, null, 2)}\n`,
  );
  execFileSync('git', ['-C', work, 'add', '.overcenter/project-intent.json'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'commit', '-m', 'declare project intent'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'push', 'origin', 'main'], { stdio: 'ignore' });
  return git(work, ['rev-parse', 'HEAD']);
}

function agentIntent(id: string, postconditionPath: string) {
  return {
    id,
    task: {
      command: ['node', 'task.mjs', 'input.txt', 'result.txt'],
      required_paths: ['task.mjs', 'input.txt'],
      output_path: 'result.txt',
    },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: postconditionPath,
      content: 'completed:hello\n',
    },
  };
}

function sourceIntent(id: string) {
  return {
    id,
    task: {
      schema: 'overcenter-source-task/v1',
      kind: 'source-change',
      objective: 'Update the bounded source feature.',
      writable_paths: ['src/feature.txt'],
    },
  };
}

test('checked-in project intent is source-agnostic until trusted compilation', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../.overcenter/project-intent.json', import.meta.url), 'utf8'),
  );
  assert.equal(JSON.stringify(raw).includes('source_sha'), false);

  const desired = compileProjectIntent(raw);
  assert.equal(desired.length, 1);
  const compiled = desired[0];
  assert.ok(compiled);
  assert.equal(compiled.id, 'live-agent-loop-witness');
  assert.ok(compiled.packet);
  assert.deepEqual(compiled.packet.command, [
    'node',
    '--experimental-strip-types',
    'experiments/assignment-capsule/fixture-task.ts',
    'experiments/assignment-capsule/fixture-input.txt',
    'result.txt',
  ]);
  assert.equal(JSON.stringify(compiled.packet).includes('source_sha'), false);
});

test('project.advance separates pinned command implementation from project source revision', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();

    const projectSourceSha = commitProjectIntent(f.work, [
      agentIntent('external-project-work', f.postconditionPath),
    ]);
    const commandSourceSha = 'f'.repeat(40);
    const outputDir = join(f.root, 'external-project-packet');
    const receipt = advanceProjectForAgent(
      f.work,
      {
        ...commandContext(commandSourceSha),
        project_source_sha: projectSourceSha,
      },
      {
        outputDir,
        workerClientPath: workerClientFixture(f.root),
        authorityRef: AUTHORITY_REF,
        remote: 'origin',
      },
    );

    assert.equal(receipt.command_source_sha, commandSourceSha);
    assert.equal(receipt.candidate_branch_base_sha, projectSourceSha);
    assert.equal(receipt.obligation_id, 'external-project-work');
    assert.equal(
      new GitOvercenterKernel(f.work, {
        remote: 'origin',
        ref: AUTHORITY_REF,
      }).claimedSourceRevision(receipt.run_id!),
      projectSourceSha,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance binds bounded source intent to the exact project revision', () => {
  const f = fixture();
  try {
    const projectSourceSha = commitProjectIntent(f.work, [
      {
        id: 'bounded-source-work',
        task: {
          schema: 'overcenter-source-task/v1',
          kind: 'source-change',
          objective: 'Improve the bounded source feature.',
          writable_paths: ['src/feature.txt'],
        },
      },
    ]);

    const outputDir = join(f.root, 'source-packet');
    const receipt = advanceProjectForAgent(
      f.work,
      {
        ...commandContext('f'.repeat(40)),
        project_source_sha: projectSourceSha,
      },
      {
        outputDir,
        authorityRef: AUTHORITY_REF,
        remote: 'origin',
      },
    );

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id, 'bounded-source-work');
    assert.equal(receipt.candidate_branch_base_sha, projectSourceSha);
    const assignment = JSON.parse(readFileSync(join(outputDir, 'assignment.json'), 'utf8'));
    assert.equal(assignment.task.kind, 'source-change');
    assert.equal(assignment.claim.source_sha, projectSourceSha);

    const authoritative = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    assert.ok(authoritative.head());
    assert.equal(authoritative.claimedSourceRevision(receipt.run_id!), projectSourceSha);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance reconciles trusted project intent before frontier selection', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();

    const sourceSha = commitProjectIntent(f.work, [
      agentIntent('intent-work', f.postconditionPath),
    ]);
    const outputDir = join(f.root, 'packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id, 'intent-work');
    const assignment = JSON.parse(readFileSync(join(outputDir, 'assignment.json'), 'utf8'));
    assert.equal(assignment.source_revision, sourceSha);
    assert.equal(JSON.stringify(assignment.work.packet).includes('source_sha'), false);

    const authoritative = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    assert.equal(authoritative.claimedSourceRevision(receipt.run_id!), sourceSha);
    const current = authoritative.inspect();
    assert.equal(current.length, 1);
    assert.equal(current[0]?.id, 'intent-work');
    assert.equal(current[0]?.status, 'EXECUTING');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project intent is an ensure-set and does not retire unmentioned obligations', () => {
  const f = fixture();
  try {
    defineAgentWork(f.work, f.postconditionPath);
    const sourceSha = commitProjectIntent(f.work, [
      agentIntent('intent-work', f.postconditionPath),
    ]);

    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'packet'),
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.ok(receipt.obligation_id);
    assert.ok(['intent-work', 'real-frontier-work'].includes(receipt.obligation_id));

    const current = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.deepEqual(
      current.map((work) => work.id),
      ['intent-work', 'real-frontier-work'],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('invalid trusted project intent fails before authority movement', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const before = kernel.head();

    mkdirSync(join(f.work, '.overcenter'), { recursive: true });
    writeFileSync(
      join(f.work, '.overcenter', 'project-intent.json'),
      JSON.stringify({
        schema: 'overcenter-project-intent/v1',
        obligations: [
          {
            ...agentIntent('bad-intent', f.postconditionPath),
            retire: ['something'],
          },
        ],
      }),
    );
    execFileSync('git', ['-C', f.work, 'add', '.overcenter/project-intent.json'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'invalid project intent'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'push', 'origin', 'main'], { stdio: 'ignore' });
    const sourceSha = git(f.work, ['rev-parse', 'HEAD']);

    assert.throws(
      () =>
        advanceProjectForAgent(f.work, commandContext(sourceSha), {
          outputDir: join(f.root, 'packet'),
          authorityRef: AUTHORITY_REF,
          remote: 'origin',
        }),
      /PROJECT_INTENT_OBLIGATION_INVALID:0:UNKNOWN_FIELD:retire/,
    );

    const after = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    assert.equal(after.head(), before);
    assert.deepEqual(after.inspect(), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance selects and claims real READY work, then emits a bounded packet', () => {
  const f = fixture();
  try {
    defineAgentWork(f.work, f.postconditionPath);
    const outputDir = join(f.root, 'packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
      outputDir,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id, 'real-frontier-work');
    assert.ok(receipt.run_id);
    assert.ok(receipt.claimed_revision);
    assert.match(receipt.assignment_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(receipt.candidate_branch, `overcenter/candidate/${receipt.run_id}`);
    assert.equal(receipt.candidate_branch_base_sha, f.sourceSha);

    const assignmentBytes = readFileSync(join(outputDir, 'assignment.json'));
    const assignment = JSON.parse(assignmentBytes.toString('utf8'));
    assert.equal(assignment.work.id, 'real-frontier-work');
    assert.equal(assignment.work.status, 'EXECUTING');
    assert.equal(assignment.work.run_id, receipt.run_id);
    assert.equal(assignment.source_revision, f.sourceSha);
    assert.equal(JSON.stringify(assignment.work.packet).includes('source_sha'), false);
    assert.equal(assignmentBytes.includes(Buffer.from('execution_capability')), false);
    assert.deepEqual(
      assignment.files.map((file: { path: string }) => file.path),
      ['task.mjs', 'input.txt'],
    );
    const workerClient = join(outputDir, 'overcenter');
    assert.ok((statSync(workerClient).mode & 0o111) !== 0);
    assert.deepEqual(
      readFileSync(workerClient),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]),
    );

    const current = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.equal(current.length, 1, 'project.advance must not manufacture request obligations');
    assert.equal(current[0]?.id, 'real-frontier-work');
    assert.equal(current[0]?.status, 'EXECUTING');
    assert.equal(current[0]?.run_id, receipt.run_id);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance materializes an exact tracked repository tree into a concrete packet', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.work, 'bin'), { recursive: true });
    mkdirSync(join(f.work, 'lib'), { recursive: true });
    writeFileSync(join(f.work, 'bin', 'tool.sh'), '#!/bin/sh\nprintf tree-tool\\n');
    chmodSync(join(f.work, 'bin', 'tool.sh'), 0o755);
    writeFileSync(join(f.work, 'lib', 'nested.txt'), 'tracked-tree-byte\n');
    execFileSync('git', ['-C', f.work, 'add', 'bin/tool.sh', 'lib/nested.txt'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'add tracked source tree'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'push', 'origin', 'main'], { stdio: 'ignore' });
    const sourceSha = git(f.work, ['rev-parse', 'HEAD']);

    // Ambient workspace bytes are deliberately not authority for the packet.
    writeFileSync(join(f.work, 'untracked-secret.txt'), 'must-not-cross-boundary\n');

    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    kernel.define({
      id: 'repository-tree-work',
      packet: {
        schema: 'overcenter-agent-task/v2',
        kind: 'pure-candidate',
        command: ['/bin/true'],
        required_paths: [],
        required_trees: ['.'],
        output_path: 'result.txt',
      },
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: f.postconditionPath,
        content: 'done\n',
      },
    });

    const outputDir = join(f.root, 'tree-packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.candidate_branch_base_sha, sourceSha);
    const assignment = JSON.parse(readFileSync(join(outputDir, 'assignment.json'), 'utf8'));
    assert.equal(assignment.source_revision, sourceSha);
    assert.equal('required_trees' in assignment.work.packet, false);

    const files = assignment.files as Array<{
      path: string;
      mode: string;
      content_base64: string;
    }>;
    assert.deepEqual(
      files.map((file) => file.path),
      [
        '.github/workflows/agent-candidate-signal.yml',
        '.overcenter/source-verification-profile.json',
        'bin/tool.sh',
        'input.txt',
        'lib/nested.txt',
        'src/feature.txt',
        'task.mjs',
      ],
    );
    assert.deepEqual(
      assignment.work.packet.required_paths,
      files.map((file) => file.path),
    );
    assert.equal(files.find((file) => file.path === 'bin/tool.sh')?.mode, '100755');
    assert.equal(files.find((file) => file.path === 'lib/nested.txt')?.mode, '100644');
    assert.equal(
      Buffer.from(
        files.find((file) => file.path === 'lib/nested.txt')!.content_base64,
        'base64',
      ).toString('utf8'),
      'tracked-tree-byte\n',
    );
    assert.equal(
      files.some((file) => file.path === 'untracked-secret.txt'),
      false,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project intent accepts repository-tree selectors without embedding a source revision', () => {
  const compiled = compileProjectIntent({
    schema: 'overcenter-project-intent/v1',
    obligations: [
      {
        id: 'tree-intent',
        task: {
          command: ['/bin/true'],
          required_paths: [],
          required_trees: ['src'],
          output_path: 'result.txt',
        },
        postcondition: {
          verifier: 'file-content-equals/v1',
          path: '/tmp/overcenter-tree-intent/result.txt',
          content: 'done\n',
        },
      },
    ],
  });
  assert.equal(compiled.length, 1);
  const compiledTask = compiled[0];
  assert.ok(compiledTask?.packet);
  assert.deepEqual(compiledTask.packet.required_trees, ['src']);
  assert.equal(JSON.stringify(compiledTask.packet).includes('source_sha'), false);
});

test('project.advance emits a source assignment without a worker executable', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const outputDir = join(f.root, 'source-packet');

    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir,
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id, 'source-work');
    assert.equal(receipt.candidate_branch_base_sha, sourceSha);
    assert.ok(receipt.run_id);
    assert.match(receipt.assignment_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(existsSync(join(outputDir, 'overcenter')), false);

    const assignment = JSON.parse(readFileSync(join(outputDir, 'assignment.json'), 'utf8'));
    assert.equal(assignment.schema, 'overcenter-source-assignment/v1');
    assert.equal(assignment.obligation_id, 'source-work');
    assert.equal(assignment.task.kind, 'source-change');
    assert.equal(assignment.claim.run_id, receipt.run_id);
    assert.equal(assignment.claim.source_sha, sourceSha);
    assert.equal(assignment.proposal_schema, SOURCE_PROPOSAL_SCHEMA);
    assert.equal(JSON.stringify(assignment).includes('execution_capability'), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('source proposal broker rejects control-plane mutation before candidate publication', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const acquired = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'source-packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.ok(acquired.run_id);

    const assignment = JSON.parse(
      readFileSync(join(f.root, 'source-packet', 'assignment.json'), 'utf8'),
    );
    const claim = assignment.claim;
    assert.throws(
      () =>
        brokerAssignedSourceProposal(
          f.work,
          assignment,
          {
            schema: SOURCE_PROPOSAL_SCHEMA,
            run_id: claim.run_id,
            claimed_revision: claim.claimed_revision,
            claimed_source_sha: claim.source_sha,
            files: [
              {
                path: '.github/workflows/evil.yml',
                content_base64: Buffer.from('name: evil\n').toString('base64'),
              },
            ],
          },
          { authorityRef: AUTHORITY_REF, remote: 'origin' },
        ),
      /SOURCE_PROPOSAL_PATH_INVALID:0/,
    );

    const candidateRef = `refs/heads/overcenter/candidate/${claim.run_id}`;
    assert.equal(git(f.work, ['ls-remote', 'origin', candidateRef]), '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('generic source proposal broker reproduces a worker revision tree exactly', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const acquired = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'source-packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.ok(acquired.run_id);

    execFileSync('git', ['-C', f.work, 'switch', '-c', 'untrusted-proposal', sourceSha], {
      stdio: 'ignore',
    });
    writeFileSync(join(f.work, 'src', 'feature.txt'), 'feature:proposal-ref\n');
    execFileSync('git', ['-C', f.work, 'add', 'src/feature.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'worker proposal'], { stdio: 'ignore' });
    const proposalSha = git(f.work, ['rev-parse', 'HEAD']);

    const assignment = JSON.parse(
      readFileSync(join(f.root, 'source-packet', 'assignment.json'), 'utf8'),
    );
    const claim = assignment.claim;
    const brokered = brokerAssignedSourceProposal(
      f.work,
      assignment,
      {
        schema: SOURCE_PROPOSAL_SCHEMA,
        run_id: claim.run_id,
        claimed_revision: claim.claimed_revision,
        claimed_source_sha: claim.source_sha,
        files: [
          {
            path: 'src/feature.txt',
            content_base64: Buffer.from('feature:proposal-ref\n').toString('base64'),
          },
        ],
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );

    assert.equal(brokered.publication.state, 'PUBLISHED');
    assert.notEqual(brokered.candidate.commit_sha, proposalSha);
    assert.equal(git(f.work, ['rev-parse', `${brokered.candidate.commit_sha}^`]), sourceSha);
    assert.equal(
      git(f.work, ['rev-parse', `${brokered.candidate.commit_sha}^{tree}`]),
      git(f.work, ['rev-parse', `${proposalSha}^{tree}`]),
    );
    const message = git(f.work, ['show', '-s', '--format=%B', brokered.candidate.commit_sha]);
    assert.match(message, new RegExp(`Overcenter-Claimed-Source: ${sourceSha}`));
    assert.match(message, /Overcenter-Obligation-Id: source-work/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.submit refuses to publish a verified source candidate directly to main', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const acquired = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'source-packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    const runId = runId;
    assert.ok(runId);

    const assignment = JSON.parse(
      readFileSync(join(f.root, 'source-packet', 'assignment.json'), 'utf8'),
    );
    const claim = assignment.claim;
    const brokered = brokerAssignedSourceProposal(
      f.work,
      assignment,
      {
        schema: SOURCE_PROPOSAL_SCHEMA,
        run_id: claim.run_id,
        claimed_revision: claim.claimed_revision,
        claimed_source_sha: claim.source_sha,
        files: [
          {
            path: 'src/feature.txt',
            content_base64: Buffer.from('feature:integrated\n').toString('base64'),
          },
        ],
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(brokered.publication.state, 'PUBLISHED');
    const candidateSha = brokered.candidate.commit_sha;
    const plan = buildSourceTransactionPlan({
      repo: f.work,
      taskValue: assignment.task,
      claim,
      candidateSha,
      context: transactionContext,
    });
    const verificationPath = join(f.root, 'source-verification.json');
    writeFileSync(
      verificationPath,
      JSON.stringify(
        sourceProofRecord(
          plan,
          { workflow_run_id: 123, workflow_run_attempt: 1, job_id: 11 },
          'success',
        ),
      ),
    );

    const remoteMainBefore = git(f.work, ['ls-remote', 'origin', 'refs/heads/main']).split(
      /\s+/,
    )[0];
    assert.throws(
      () =>
        submitProjectCandidate(
          f.work,
          {
            ...commandContext(transactionContext.runtime_sha, 9100),
            candidate_sha: candidateSha,
            candidate_run_id: runId,
            candidate_workflow_run_id: 123,
            candidate_workflow_run_attempt: 1,
          },
          {
            authorityRef: AUTHORITY_REF,
            remote: 'origin',
            sourceVerificationPath: verificationPath,
            githubToken: 'fixture',
            transactionContext,
            observationContext: { githubGet: sourceProofProvider(candidateSha, runId) },
          },
        ),
      /PROJECT_SUBMIT_SOURCE_PUBLICATION_REQUIRES_PR_EFFECT/,
    );
    const remoteMainAfter = git(f.work, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
    assert.equal(remoteMainAfter, remoteMainBefore);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('certified source verification rejection returns work to READY without moving source authority', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const acquired = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'source-packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.ok(acquired.run_id);

    const assignment = JSON.parse(
      readFileSync(join(f.root, 'source-packet', 'assignment.json'), 'utf8'),
    );
    const claim = assignment.claim;
    const brokered = brokerAssignedSourceProposal(
      f.work,
      assignment,
      {
        schema: SOURCE_PROPOSAL_SCHEMA,
        run_id: claim.run_id,
        claimed_revision: claim.claimed_revision,
        claimed_source_sha: claim.source_sha,
        files: [
          {
            path: 'src/feature.txt',
            content_base64: Buffer.from('feature:rejected\n').toString('base64'),
          },
        ],
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(brokered.publication.state, 'PUBLISHED');
    const candidateSha = brokered.candidate.commit_sha;
    const plan = buildSourceTransactionPlan({
      repo: f.work,
      taskValue: assignment.task,
      claim,
      candidateSha,
      context: transactionContext,
    });
    const verificationPath = join(f.root, 'source-verification.json');
    writeFileSync(
      verificationPath,
      JSON.stringify(
        sourceProofRecord(
          plan,
          { workflow_run_id: 123, workflow_run_attempt: 1, job_id: 11 },
          'failure',
        ),
      ),
    );

    const result = submitProjectCandidate(
      f.work,
      {
        ...commandContext(transactionContext.runtime_sha, 9200),
        candidate_sha: candidateSha,
        candidate_run_id: acquired.run_id,
        candidate_workflow_run_id: 123,
        candidate_workflow_run_attempt: 1,
      },
      {
        authorityRef: AUTHORITY_REF,
        remote: 'origin',
        sourceVerificationPath: verificationPath,
        githubToken: 'fixture',
        transactionContext,
        observationContext: {
          githubGet: sourceProofProvider(candidateSha, acquired.run_id, 'failure'),
        },
      },
    );

    assert.equal(result.disposition, 'READY');
    assert.equal(result.verified, false);
    const remoteMain = git(f.work, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
    assert.equal(remoteMain, sourceSha);
    const authoritative = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    assert.equal(authoritative.inspect()[0]?.status, 'READY');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});
test('project.advance requires native client bytes before claiming reasoning work', () => {
  const f = fixture();
  try {
    defineAgentWork(f.work, f.postconditionPath);
    const before = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    const head = before.head();

    assert.throws(
      () =>
        advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
          outputDir: join(f.root, 'packet'),
          authorityRef: AUTHORITY_REF,
          remote: 'origin',
        }),
      /PROJECT_ADVANCE_WORKER_CLIENT_REQUIRED/,
    );

    const after = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    assert.equal(after.head(), head);
    assert.equal(after.inspect()[0]?.status, 'READY');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.submit validates exact packet identity and settles independently', () => {
  const f = fixture();
  try {
    defineAgentWork(f.work, f.postconditionPath);
    const outputDir = join(f.root, 'packet');
    const acquired = advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
      outputDir,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.equal(acquired.state, 'AGENT_EXECUTION_REQUIRED');
    assert.ok(acquired.run_id);
    assert.ok(acquired.claimed_revision);
    assert.ok(acquired.assignment_sha256);

    const output = Buffer.from('completed:hello\n');
    const candidate = {
      schema: 'overcenter-agent-candidate/v1',
      assignment_sha256: acquired.assignment_sha256,
      obligation_id: acquired.obligation_id,
      run_id: acquired.run_id,
      claimed_revision: acquired.claimed_revision,
      output_path: 'result.txt',
      output_sha256: createHash('sha256').update(output).digest('hex'),
      output_base64: output.toString('base64'),
    };
    mkdirSync(join(f.work, '.overcenter'), { recursive: true });
    writeFileSync(
      join(f.work, '.overcenter', 'candidate.json'),
      `${JSON.stringify(candidate, null, 2)}\n`,
    );
    execFileSync('git', ['-C', f.work, 'add', '.overcenter/candidate.json'], { stdio: 'ignore' });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'candidate bytes'], { stdio: 'ignore' });
    const candidateSha = git(f.work, ['rev-parse', 'HEAD']);

    const settled = submitProjectCandidate(
      f.work,
      {
        ...commandContext('e'.repeat(40), 9002),
        candidate_sha: candidateSha,
        candidate_run_id: acquired.run_id,
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
    assert.equal(settled.already_settled, false);
    assert.equal(settled.run_id, acquired.run_id);
    assert.ok(settled.settlement_commit);

    const current = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.equal(current[0]?.status, 'DONE');

    const replay = submitProjectCandidate(
      f.work,
      {
        ...commandContext('f'.repeat(40), 9003),
        candidate_sha: candidateSha,
        candidate_run_id: acquired.run_id,
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(replay.disposition, 'DONE');
    assert.equal(replay.verified, true);
    assert.equal(replay.already_settled, true);
    assert.equal(replay.settlement_commit, settled.settlement_commit);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance persists stale DONE realization before replacement claim', () => {
  const f = fixture();
  try {
    const sourceSha = commitProjectIntent(f.work, [
      agentIntent('refreshable-work', f.postconditionPath),
    ]);
    const first = advanceProjectForAgent(f.work, commandContext(sourceSha, 9500), {
      outputDir: join(f.root, 'first-refresh-packet'),
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.equal(first.state, 'AGENT_EXECUTION_REQUIRED');
    assert.ok(first.run_id);

    mkdirSync(f.postconditionRoot, { recursive: true });
    writeFileSync(f.postconditionPath, 'completed:hello\n');
    const settlementKernel = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    const settledPermit = settlementKernel.acquireExecution(first.run_id);
    const settled = settlementKernel.resolve(settledPermit);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);

    rmSync(f.postconditionPath);
    const secondOutput = join(f.root, 'second-refresh-packet');
    const second = advanceProjectForAgent(f.work, commandContext(sourceSha, 9501), {
      outputDir: secondOutput,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(second.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(second.obligation_id, 'refreshable-work');
    assert.ok(second.run_id);
    assert.notEqual(second.run_id, first.run_id);

    const authoritative = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    assert.equal(authoritative.receipts(first.run_id).at(-1)?.disposition, 'READY');
    assert.doesNotThrow(() => authoritative.claimedWork(second.run_id!));
    assert.equal(authoritative.inspect()[0]?.status, 'EXECUTING');
    assert.ok(existsSync(join(secondOutput, 'assignment.json')));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance reports DONE for an empty authoritative graph', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const receipt = advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
      outputDir: join(f.root, 'packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.equal(receipt.state, 'DONE');
    assert.equal(receipt.run_id, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('legacy hostile-evidence labels cannot bypass the source reasoning boundary', () => {
  const fixtureState = fixture();
  try {
    const kernel = new GitOvercenterKernel(fixtureState.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    kernel.initialize();
    const obligationId = 'tcb:hostile-evidence-stale:fixture:probe';
    const sourceSha = commitProjectIntent(fixtureState.work, [
      {
        id: obligationId,
        task: {
          schema: 'overcenter-source-task/v1',
          kind: 'source-change',
          objective: 'Refresh hostile mutation evidence from the exact current source.',
          writable_paths: [
            'experiments/production-criticality-ranking/mutation-evidence.json',
            'src/feature.txt',
          ],
          acceptance: {
            verifier: 'tcb-finding-absent/v1',
            finding_id: obligationId,
          },
          context: {
            schema: 'overcenter-tcb-finding/v1',
            finding_kind: 'hostile-evidence-stale',
            scope: 'fixture',
            evidence: {
              probe_id: 'fixture-probe',
              stale_sources: [
                {
                  path: 'src/feature.txt',
                  expected_blob_sha1: 'a'.repeat(40),
                  current_blob_sha1: 'b'.repeat(40),
                  current: false,
                },
              ],
            },
          },
        },
      },
    ]);

    const outputDir = join(fixtureState.root, 'derivable-source-packet');
    const receipt = advanceProjectForAgent(fixtureState.work, commandContext(sourceSha, 9300), {
      outputDir,
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id, obligationId);
    assert.ok(receipt.run_id);
    assert.ok(existsSync(join(outputDir, 'assignment.json')));

    const assignment = JSON.parse(readFileSync(join(outputDir, 'assignment.json'), 'utf8'));
    assert.equal(assignment.task.kind, 'source-change');
    assert.equal(assignment.claim.run_id, receipt.run_id);

    const current = new GitOvercenterKernel(fixtureState.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.equal(current[0]?.status, 'EXECUTING');
    assert.equal(current[0]?.run_id, receipt.run_id);
  } finally {
    rmSync(fixtureState.root, { recursive: true, force: true });
    rmSync(fixtureState.postconditionRoot, { recursive: true, force: true });
  }
});

test('ambiguous reserved source mutation blocks otherwise READY agent work', () => {
  const fixtureState = fixture();
  try {
    const kernel = new GitOvercenterKernel(fixtureState.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    kernel.initialize();
    const sourceSha = commitProjectIntent(fixtureState.work, [
      sourceIntent('a-source-work'),
      agentIntent('z-agent-work', fixtureState.postconditionPath),
    ]);

    const first = advanceProjectForAgent(fixtureState.work, commandContext(sourceSha, 9400), {
      outputDir: join(fixtureState.root, 'first-source-packet'),
      workerClientPath: workerClientFixture(fixtureState.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.equal(first.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(first.obligation_id, 'a-source-work');
    assert.ok(first.run_id);

    const interruptedKernel = new GitOvercenterKernel(fixtureState.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    const permit = interruptedKernel.acquireExecution(first.run_id);
    interruptedKernel.beginEffect(permit);
    const interrupted = interruptedKernel.recoverInterrupted(permit, {
      failure: 'simulated-ambiguous-source-push',
    });
    assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');
    assert.equal(interruptedKernel.hasUnresolvedEffect(first.run_id), true);

    const secondOutput = join(fixtureState.root, 'second-agent-packet');
    const second = advanceProjectForAgent(fixtureState.work, commandContext(sourceSha, 9401), {
      outputDir: secondOutput,
      workerClientPath: workerClientFixture(fixtureState.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(second.state, 'RECOVERY_REQUIRED');
    assert.equal(second.obligation_id, 'a-source-work');
    assert.equal(second.run_id, first.run_id);
    assert.equal(existsSync(secondOutput), false);

    const current = new GitOvercenterKernel(fixtureState.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.equal(current.find((work) => work.id === 'a-source-work')?.status, 'RECOVERY_REQUIRED');
    assert.equal(current.find((work) => work.id === 'z-agent-work')?.status, 'READY');
    assert.equal(current.find((work) => work.id === 'z-agent-work')?.run_id, undefined);
  } finally {
    rmSync(fixtureState.root, { recursive: true, force: true });
    rmSync(fixtureState.postconditionRoot, { recursive: true, force: true });
  }
});

function sourceProofProvider(
  candidateSha: string,
  runId: string,
  evidenceConclusion: 'success' | 'failure' = 'success',
) {
  return (_token: string, path: string): unknown => {
    if (path.endsWith('/actions/runs/123'))
      return {
        id: 123,
        path: '.github/workflows/agent-candidate-signal.yml',
        run_attempt: 1,
        head_sha: candidateSha,
        head_branch: `overcenter/candidate/${runId}`,
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: evidenceConclusion,
        repository: { id: 42 },
        head_repository: { id: 42 },
      };
    if (path.endsWith('/attempts/1/jobs?per_page=100'))
      return {
        jobs: [
          {
            id: 10,
            status: 'completed',
            run_id: 123,
            head_sha: candidateSha,
            name: 'Verify source candidate / Candidate evidence',
            conclusion: evidenceConclusion,
          },
          {
            id: 11,
            status: 'completed',
            run_id: 123,
            head_sha: candidateSha,
            name: 'Record source verification',
            conclusion: 'success',
          },
        ],
      };
    if (path.endsWith('/artifacts?per_page=100'))
      return {
        artifacts: [
          {
            id: 12,
            name: 'overcenter-source-verification',
            expired: false,
            digest: `sha256:${'f'.repeat(64)}`,
            workflow_run: {
              id: 123,
              repository_id: 42,
              head_repository_id: 42,
              head_sha: candidateSha,
            },
          },
        ],
      };
    return { id: 42, full_name: 'acme/widget' };
  };
}
