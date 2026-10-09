import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareSourceCandidate } from '../src/source/source-preparation.ts';
import { brokerSourceProposal } from '../src/source/source-broker.ts';

const VERSION = '0.13.2';
const PROFILE = '.overcenter/source-preparation-profile.json';

function repository(
  t: import('node:test').TestContext,
  options: {
    profile?: boolean;
    additionalWrite?: boolean;
    ignoreAdditionalWrite?: boolean;
    wrongVersion?: boolean;
    engine?: 'ruff' | 'biome' | 'gofmt' | 'rustfmt';
  } = {},
) {
  const engine = options.engine ?? 'ruff';
  const version = { ruff: VERSION, biome: '2.5.14', gofmt: '1.24.13', rustfmt: '1.98.1' }[engine];
  const extension = { ruff: '.py', biome: '.ts', gofmt: '.go', rustfmt: '.rs' }[engine];
  const root = mkdtempSync(join(tmpdir(), 'overcenter-preparation-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Preparation test');
  git('config', 'user.email', 'preparation@local');
  mkdirSync(join(root, '.overcenter'));
  mkdirSync(join(root, 'src'));
  if (options.profile !== false) {
    writeFileSync(
      join(root, PROFILE),
      JSON.stringify({
        schema: 'overcenter-source-preparation-profile/v1',
        tools: [{ engine, version, extensions: [extension], safe_fixes: engine === 'ruff' }],
        max_passes: 3,
        timeout_ms: 5000,
      }) + '\n',
    );
  }
  if (options.ignoreAdditionalWrite) writeFileSync(join(root, '.gitignore'), 'src/extra.py\n');
  writeFileSync(join(root, 'src', 'hello.py'), 'x = 0\n');
  git('add', '.');
  git('commit', '-qm', 'accepted baseline');
  const base = git('rev-parse', 'HEAD');
  const bin = mkdtempSync(join(tmpdir(), 'overcenter-preparation-tool-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const tool = join(bin, engine);
  const mock =
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const a = process.argv.slice(2);',
      `if (a[0] === "--version" || a[0] === "version") { console.log("${engine} ${options.wrongVersion ? '9.9.9' : version}"); process.exit(0); }`,
      'if (a[0] === "check") process.exit(0);',
      'if (!["format", "-w", "--edition"].includes(a[0])) process.exit(3);',
      'if (!a.includes("--")) { console.error("missing filename boundary"); process.exit(4); }',
      'for (const p of a.slice(a.indexOf("--") + 1)) {',
      '  const v = fs.readFileSync(p, "utf8");',
      '  fs.writeFileSync(p, v.replace("x=  1", "x = 1"));',
      '}',
      ...(options.additionalWrite ? ['fs.writeFileSync("src/extra.py", "extra = true\\n");'] : []),
    ].join('\n') + '\n';
  writeFileSync(tool, mock);
  chmodSync(tool, 0o755);
  if (engine === 'gofmt' || engine === 'rustfmt') {
    const versionTool = join(bin, engine === 'gofmt' ? 'go' : 'rustc');
    writeFileSync(versionTool, mock);
    chmodSync(versionTool, 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  return { root, git, base };
}

const proposal = (contents: string) => [
  { path: 'src/hello.py', content_base64: Buffer.from(contents).toString('base64') },
];

for (const [engine, path] of [
  ['biome', '--config-path=missing.ts'],
  ['gofmt', '-w.go'],
  ['rustfmt', '--config-path=missing.rs'],
] as const) {
  test(`${engine} treats leading-dash proposal paths as filenames`, (t) => {
    const { root, base } = repository(t, { engine });
    writeFileSync(join(root, path), 'x=  1\n');
    const receipt = prepareSourceCandidate(
      root,
      base,
      [{ path, content_base64: Buffer.from('x=  1\n').toString('base64') }],
      ['.overcenter'],
    );
    assert.equal(receipt.status, 'NORMALIZED');
    assert.equal(readFileSync(join(root, path), 'utf8'), 'x = 1\n');
  });
}

test('broker publishes only the normalized commit and binds its preparation receipt', (t) => {
  const { root, git } = repository(t);
  writeFileSync(
    join(root, '.overcenter/source-verification-profile.json'),
    JSON.stringify({
      schema: 'overcenter-source-verification-profile/v1',
      id: 'fixture/v1',
      workflow_path: '.github/workflows/verify.yml',
      required_evidence_jobs: ['Verify source candidate / Candidate evidence'],
      record_job: 'Record source verification',
      commands: ['python tools/check.py'],
      protected_paths: ['.github', '.overcenter'],
      baseline_test_roots: ['test'],
    }),
  );
  git('add', '.');
  git('commit', '-qm', 'accepted verification profile');
  const base = git('rev-parse', 'HEAD');
  const remote = mkdtempSync(join(tmpdir(), 'overcenter-preparation-remote-'));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', '-q', remote]);
  git('remote', 'add', 'origin', remote);
  const claim = {
    obligation_key: 'fixture-obligation',
    run_id: 'normalization-canary',
    claimed_revision: 'fixture-authority-revision',
    source_sha: base,
  };
  const result = brokerSourceProposal(
    root,
    'fixture-work',
    {
      schema: 'overcenter-source-task/v1',
      kind: 'source-change',
      objective: 'normalize a bounded candidate',
      writable_paths: ['src/hello.py'],
    },
    claim,
    {
      schema: 'overcenter-source-proposal/v1',
      run_id: claim.run_id,
      claimed_revision: claim.claimed_revision,
      claimed_source_sha: base,
      files: proposal('x=  1\n'),
    },
  );
  assert.equal(result.publication.state, 'PUBLISHED');
  assert.equal(result.preparation.status, 'NORMALIZED');
  const candidate = result.candidate.commit_sha;
  assert.equal(git('rev-parse', `${candidate}^`), base);
  assert.equal(git('show', `${candidate}:src/hello.py`), 'x = 1');
  const published = execFileSync(
    'git',
    ['--git-dir', remote, 'rev-parse', `refs/heads/overcenter/candidate/${claim.run_id}`],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(published, candidate);
  const message = git('show', '-s', '--format=%B', candidate);
  assert.ok(
    message.includes(`Overcenter-Preparation-Input: ${result.preparation.proposal_sha256}`),
  );
  assert.ok(
    message.includes(`Overcenter-Preparation-Output: ${result.preparation.normalized_sha256}`),
  );
  assert.ok(
    message.includes(`Overcenter-Preparation-Profile: ${result.preparation.profile_sha256}`),
  );
});

test('normalization converges before a source candidate is committed', (t) => {
  const { root, base } = repository(t);
  writeFileSync(join(root, 'src/hello.py'), 'x=  1\n');
  const receipt = prepareSourceCandidate(root, base, proposal('x=  1\n'), ['.overcenter']);
  assert.equal(receipt.status, 'NORMALIZED');
  assert.equal(receipt.source_sha, base);
  assert.match(receipt.profile_sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(receipt.passes, 2);
  assert.deepEqual(receipt.applied_tools, ['ruff']);
  assert.equal(readFileSync(join(root, 'src/hello.py'), 'utf8'), 'x = 1\n');

  const repeated = prepareSourceCandidate(root, base, proposal('x = 1\n'), ['.overcenter']);
  assert.equal(repeated.status, 'UNCHANGED');
  assert.equal(repeated.passes, 1);
  assert.equal(repeated.proposal_sha256, receipt.normalized_sha256);
});

test('extra writes from tools fail closed', (t) => {
  const { root, base } = repository(t, { additionalWrite: true });
  writeFileSync(join(root, 'src/hello.py'), 'x=  1\n');
  assert.throws(
    () => prepareSourceCandidate(root, base, proposal('x=  1\n'), ['.overcenter']),
    /SOURCE_PREPARATION_SCOPE_VIOLATION:src\/extra.py/,
  );
});

test('ignored formatter artifacts still violate the exact write set', (t) => {
  const { root, base } = repository(t, { additionalWrite: true, ignoreAdditionalWrite: true });
  writeFileSync(join(root, 'src/hello.py'), 'x=  1\n');
  assert.throws(
    () => prepareSourceCandidate(root, base, proposal('x=  1\n'), ['.overcenter']),
    /SOURCE_PREPARATION_SCOPE_VIOLATION:src\/extra.py/,
  );
});

test('wrong formatter version is rejected before publishing candidate', (t) => {
  const { root, base } = repository(t, { wrongVersion: true });
  writeFileSync(join(root, 'src/hello.py'), 'x=  1\n');
  assert.throws(
    () => prepareSourceCandidate(root, base, proposal('x=  1\n'), ['.overcenter']),
    /SOURCE_PREPARATION_TOOL_VERSION_MISMATCH:ruff/,
  );
});

test('disabled baseline profile does not run untrusted candidate tooling', (t) => {
  const { root, base } = repository(t, { profile: false });
  writeFileSync(join(root, 'src/hello.py'), 'x=  1\n');
  const receipt = prepareSourceCandidate(root, base, proposal('x=  1\n'), ['.overcenter']);
  assert.equal(receipt.status, 'UNCONFIGURED');
  assert.deepEqual(receipt.applied_tools, []);
  assert.equal(readFileSync(join(root, 'src/hello.py'), 'utf8'), 'x=  1\n');
});

test('protected paths and symlink proposals are never normalized', (t) => {
  const { root, base } = repository(t);
  const content = proposal('x=  1\n');
  assert.throws(
    () =>
      prepareSourceCandidate(
        root,
        base,
        [{ ...content[0]!, path: '.overcenter/policy.py' }],
        ['.overcenter'],
      ),
    /SOURCE_PREPARATION_PATH_FORBIDDEN/,
  );
});

test('deletion-only proposals do not invoke formatters', (t) => {
  const { root, base } = repository(t);
  rmSync(join(root, 'src/hello.py'));
  const receipt = prepareSourceCandidate(
    root,
    base,
    [{ path: 'src/hello.py', content_base64: null }],
    ['.overcenter'],
  );
  assert.equal(receipt.status, 'UNCHANGED');
  assert.equal(receipt.passes, 0);
  assert.deepEqual(receipt.applied_tools, []);
});

test('deleted paths with absent parent directories remain valid', (t) => {
  const { root, base } = repository(t);
  const receipt = prepareSourceCandidate(
    root,
    base,
    [{ path: 'absent/child.py', content_base64: null }],
    ['.overcenter'],
  );
  assert.equal(receipt.status, 'UNCHANGED');
  assert.equal(receipt.passes, 0);
});
