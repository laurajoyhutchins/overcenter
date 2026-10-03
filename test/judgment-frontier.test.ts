import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';
import { advanceProjectForAgent } from '../src/authority/project-agent-protocol.ts';
import { fixture, commandContext, git } from './support/project-agent-fixture.ts';

const AUTHORITY_REF = 'refs/overcenter/test-project-agent';

test('unsupported READY work reports a blocked frontier without claiming authority', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    kernel.define({
      id: 'deterministic-effect',
      packet: { schema: 'provider-effect/v1', kind: 'provider-effect' },
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: f.postconditionPath,
        content: 'done\n',
      },
    });
    const before = kernel.head();

    const receipt = advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
      outputDir: join(f.root, 'packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.equal(receipt.state, 'BLOCKED');
    assert.equal(receipt.obligation_id, 'deterministic-effect');
    assert.equal(receipt.run_id, undefined);

    const after = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    assert.equal(after.head(), before);
    assert.equal(after.inspect()[0]?.status, 'READY');
    assert.equal(after.inspect()[0]?.run_id, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('declared operator judgment remains blocked without claiming agent work', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    kernel.define({
      id: 'operator-decision',
      packet: { kind: 'judgment-required' },
      postcondition: {
        verifier: 'operator-judgment/v1',
        subject: { question: 'choose' },
      },
    });

    const outputDir = join(f.root, 'judgment-packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
      outputDir,
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'BLOCKED');
    assert.equal(receipt.obligation_id, 'operator-decision');
    assert.equal(receipt.run_id, undefined);
    assert.equal(existsSync(outputDir), false);

    const authoritative = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    const explanation = authoritative.explain('operator-decision');
    assert.equal(explanation.status, 'BLOCKED');
    assert.equal(explanation.reason.kind, 'judgment-required');
    assert.equal(authoritative.inspect()[0]?.run_id, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance surfaces READY system evidence without claiming agent work', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();

    const evidenceRoot = join(f.work, 'experiments', 'production-criticality-ranking');
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(
      join(evidenceRoot, 'mutation-probes.json'),
      `${JSON.stringify(
        {
          schema: 'overcenter-criticality-mutation-probes/v1',
          probes: [
            {
              id: 'fixture-proof',
              selectors: [{ file: 'task.mjs', name: 'fixtureTask' }],
              tests: ['test/fixture.test.ts'],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(evidenceRoot, 'mutation-evidence.json'),
      `${JSON.stringify(
        {
          schema: 'overcenter-criticality-mutation-evidence',
          probes: [],
        },
        null,
        2,
      )}\n`,
    );
    execFileSync('git', ['-C', f.work, 'add', 'experiments/production-criticality-ranking'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'configure hostile evidence'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'push', 'origin', 'main'], { stdio: 'ignore' });
    const sourceSha = git(f.work, ['rev-parse', 'HEAD']);

    const outputDir = join(f.root, 'system-evidence-packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir,
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'READY');
    assert.equal(receipt.obligation_id, 'system-evidence:hostile-mutation');
    assert.equal(receipt.run_id, undefined);
    assert.equal(receipt.assignment_sha256, undefined);
    assert.equal(existsSync(outputDir), false);

    const current = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.equal(current.length, 1);
    assert.equal(current[0]?.id, 'system-evidence:hostile-mutation');
    assert.equal(current[0]?.status, 'READY');
    assert.equal(current[0]?.run_id, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});
