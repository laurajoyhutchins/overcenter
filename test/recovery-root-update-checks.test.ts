import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const runner = resolve('scripts/check-recovery-root-update.ts');
const verifier = resolve('scripts/verify-recovery-root-update.ts');

test('workflow keeps owner main binding, accepted authority, and read-only root receipts', () => {
  const workflow = readFileSync('.github/workflows/protected-source-recovery.yml', 'utf8');
  assert.match(workflow, /default: protected-source/);
  assert.match(workflow, /runs-on: .*recovery-root.*ubuntu-24\.04/);
  assert.match(workflow, /runs-on: .*self-hosted.*overcenter-gcp/);
  assert.match(workflow, /test "\$GITHUB_ACTOR" = "\$GITHUB_REPOSITORY_OWNER"/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /test "\$BASE_SHA" = "\$GITHUB_SHA"/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /contents: write|persist-credentials: true/);
  assert.match(workflow, /trusted-runtime\/scripts\/verify-protected-source-recovery\.ts/);
  assert.match(
    workflow,
    /--guard-ordinary "\$GITHUB_WORKSPACE\/candidate" "\$BASE_SHA" "\$CANDIDATE_SHA"/,
  );
  assert.match(workflow, /trusted-runtime\/scripts\/verify-recovery-root-update\.ts/);
  assert.match(workflow, /trusted-runtime\/scripts\/check-recovery-root-update\.ts/);
  assert.match(workflow, /ref: \$\{\{ inputs\.evidence_sha \}\}/);
  assert.match(workflow, /verified-awaiting-owner-transition/);
  assert.match(
    workflow,
    /root-update-\$\{\{ inputs\.candidate_sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(workflow, /if:.*always\(\)|git push|gh api|GH_TOKEN|secrets\./);
  assert.match(workflow, /test "\$\(rustc \+"\$channel" --version/);
  assert.match(
    workflow,
    /go-version: \$\{\{ steps\.root-runtime-versions\.outputs\.go-version \}\}/,
  );
});

function fixture(t: import('node:test').TestContext, failure = '') {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-root-checks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@local');
  put('package.json', JSON.stringify({ type: 'module', devDependencies: { typescript: '7.0.2' } }));
  put(
    '.overcenter/source-verification-profile.json',
    JSON.stringify({
      schema: 'overcenter-source-verification-profile/v1',
      id: 'fixture/v1',
      workflow_path: '.github/workflows/verify.yml',
      required_evidence_jobs: ['verify'],
      record_job: 'record',
      commands: ['npm run lint'],
      protected_paths: ['.github', '.overcenter', 'scripts', 'src/analysis', 'biome.json'],
      baseline_test_roots: ['test'],
    }),
  );
  put('.gitignore', 'node_modules/\n');
  put('biome.json', '{}');
  put('tsconfig.json', '{}');
  put(
    'scripts/lint.sh',
    failure === 'lint'
      ? 'exit 1\n'
      : failure === 'config-skip'
        ? 'grep -q candidate biome.json && exit 0\nexit 1\n'
        : 'exit 0\n',
  );
  put('.node-version', process.version.slice(1));
  put(
    'scripts/run-unit-tests.ts',
    failure === 'tool-mutation'
      ? "import { writeFileSync } from 'node:fs'; writeFileSync('node_modules/typescript/lib/tsc.js', 'changed');"
      : failure === 'mutation'
        ? "import { writeFileSync } from 'node:fs'; writeFileSync('src/analysis/tcb-semantic-loc.ts', 'mutated');"
        : '',
  );
  const report =
    "import { writeFileSync } from 'node:fs'; const i=process.argv.indexOf('--output'); writeFileSync(process.argv[i+1], JSON.stringify({schema:'overcenter-tcb-report',schema_version:1,semantic_loc_basis:'typescript-logical-sloc/v1',properties:[{id:'fixture',scope_sha256:'a'.repeat(64),hybrid_closure_semantic_loc:1,external_module_imports:[],symbol_closure_external_symbols:[],symbol_closure_status:'sound'}],compositions:[],reconciliation:process.argv.includes('--baseline')?{admitted:true,baseline_revision:process.argv[process.argv.indexOf('--baseline')+1]}:null}));";
  put('scripts/report-tcb.ts', report);
  put('src/analysis/tcb-semantic-loc.ts', 'export const x = 1;');
  put('test/baseline.test.ts', '');
  const evidenceText =
    failure === 'evidence'
      ? "import test from 'node:test'; test('hostile',()=>{throw Error('hostile failure')});"
      : failure === 'premature-exit'
        ? 'process.exit(0);'
        : "import test from 'node:test'; test('TCB semantic LOC is invariant to source layout and comments',()=>{}); test('TCB semantic span union counts containing syntax once',()=>{});";
  const preexistingEvidence = failure.startsWith('preexisting-evidence');
  if (preexistingEvidence) {
    put(
      'test/tcb-semantic-loc.test.ts',
      failure === 'preexisting-evidence-mismatch' ? 'not the authorized evidence' : evidenceText,
    );
  }
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const trusted = join(root, 'trusted');
  git('worktree', 'add', '--detach', trusted, base);
  if (!preexistingEvidence || failure === 'preexisting-evidence-mismatch') {
    put('test/tcb-semantic-loc.test.ts', evidenceText);
    git('add', '.');
    git('commit', '-qm', 'evidence');
  }
  const evidence = git('rev-parse', 'HEAD');
  const blob = git('rev-parse', 'HEAD:test/tcb-semantic-loc.test.ts');
  git('checkout', '-q', '--detach', base);
  put('biome.json', '{"candidate":true}');
  git('add', '.');
  git('commit', '-qm', 'candidate');
  for (const dir of [repo, trusted]) {
    mkdirSync(join(dir, 'node_modules/typescript/lib'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/typescript/package.json'), '{"version":"7.0.2"}');
    writeFileSync(
      join(dir, 'node_modules/typescript/lib/tsc.js'),
      failure === 'typecheck' ? 'process.exit(1)' : '',
    );
  }
  const authorization = {
    schema: 'overcenter-recovery-root-update-authorization/v1',
    repository_full_name: 'owner/repo',
    base_sha: base,
    candidate_sha: git('rev-parse', 'HEAD'),
    candidate_tree_sha: git('rev-parse', 'HEAD^{tree}'),
    writable_paths: ['biome.json'],
    reason: 'fixture',
    authorized_by: 'owner',
    evidence_sha: evidence,
    evidence_path: 'test/tcb-semantic-loc.test.ts',
    evidence_blob_sha: blob,
  };
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_REPOSITORY_OWNER: 'owner',
    GITHUB_ACTOR: 'owner',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: base,
  };
  const auth = join(root, 'auth.json');
  const receiptPath = join(root, 'structural.json');
  writeFileSync(auth, JSON.stringify(authorization));
  const receipt = execFileSync(
    process.execPath,
    ['--experimental-strip-types', verifier, auth, repo],
    { encoding: 'utf8', env },
  );
  writeFileSync(receiptPath, receipt);
  const output = join(root, 'output');
  const run = () =>
    spawnSync(
      process.execPath,
      ['--experimental-strip-types', runner, trusted, repo, receiptPath, output],
      { encoding: 'utf8', env },
    );
  return { root, repo, trusted, put, git, receiptPath, output, run };
}

test('runs both real check chains and bound evidence, recording projection separately', (t) => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(readFileSync(join(f.output, 'verification.json'), 'utf8'));
  assert.equal(result.schema, 'overcenter-recovery-root-update-verification/v1');
  assert.equal(result.accepted_checks.length, 4);
  assert.equal(result.candidate_checks.length, 4);
  assert.equal(result.evidence_check.exit_code, 0);
  assert.match(result.evidence_check.stdout_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.evidence_check.stderr_sha256, /^[a-f0-9]{64}$/);
  assert.match(
    readFileSync(join(f.output, result.evidence_check.stdout_log), 'utf8'),
    /"type":"test:summary"/,
  );
  assert.equal(
    typeof readFileSync(join(f.output, result.evidence_check.stderr_log), 'utf8'),
    'string',
  );
  assert.match(result.projection.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.candidate_content_before, result.candidate_content_after);
});

test('reuses exact accepted hostile evidence without an injection', (t) => {
  const f = fixture(t, 'preexisting-evidence');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(readFileSync(join(f.output, 'verification.json'), 'utf8'));
  assert.equal(result.evidence_check.exit_code, 0);
  assert.equal(result.candidate_content_before, result.candidate_content_after);
});

test('rejects preexisting hostile evidence with another blob', (t) => {
  const f = fixture(t, 'preexisting-evidence-mismatch');
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /EVIDENCE_PREEXISTING_BLOB_MISMATCH/);
  assert.throws(() => readFileSync(join(f.output, 'verification.json')));
});

for (const sourcePath of ['src/analysis/tcb-semantic-loc.ts', 'scripts/report-tcb.ts']) {
  test(`accepted source checks inspect candidate ${sourcePath} before freezing measurement`, (t) => {
    const f = fixture(t);
    // The fixture accepted driver requires the candidate helper; freezing it too early hides this edit.
    f.git('checkout', '-q', '--detach', f.git('rev-parse', 'HEAD^'));
    f.put('scripts/lint.sh', `grep -q candidate_marker ${sourcePath}\n`);
    f.git('add', '.');
    f.git('commit', '-qm', 'accepted lint requirement');
    const base = f.git('rev-parse', 'HEAD');
    execFileSync('git', ['-C', f.trusted, 'checkout', '-q', '--detach', base]);
    f.put(sourcePath, `${readFileSync(join(f.repo, sourcePath), 'utf8')}\n// candidate_marker\n`);
    f.git('add', '.');
    f.git('commit', '-qm', 'helper candidate');
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
    const auth = {
      ...receipt,
      schema: 'overcenter-recovery-root-update-authorization/v1',
      base_sha: base,
      candidate_sha: f.git('rev-parse', 'HEAD'),
      candidate_tree_sha: f.git('rev-parse', 'HEAD^{tree}'),
      writable_paths: [sourcePath],
    };
    delete auth.authorization_sha256;
    delete auth.evidence_sha256;
    delete auth.accepted_profile_sha256;
    const authPath = join(f.root, 'new-auth.json');
    writeFileSync(authPath, JSON.stringify(auth));
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_REPOSITORY_OWNER: 'owner',
      GITHUB_ACTOR: 'owner',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: base,
    };
    writeFileSync(
      f.receiptPath,
      execFileSync(process.execPath, ['--experimental-strip-types', verifier, authPath, f.repo], {
        env,
      }),
    );
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', runner, f.trusted, f.repo, f.receiptPath, f.output],
      { encoding: 'utf8', env },
    );
    assert.equal(r.status, 0, r.stderr);
  });
}

for (const failure of [
  'lint',
  'typecheck',
  'mutation',
  'evidence',
  'config-skip',
  'tool-mutation',
  'premature-exit',
]) {
  test(`fails closed on genuine ${failure} failure`, (t) => {
    const f = fixture(t, failure);
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.throws(() => readFileSync(join(f.output, 'verification.json')));
    if (failure === 'config-skip') assert.match(r.stderr, /CHECK_FAILED:accepted\/lint/);
  });
}

test('recomputes structural receipt and rejects forged status or digest', (t) => {
  const f = fixture(t);
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  receipt.authorization_sha256 = '0'.repeat(64);
  receipt.checks = 'passed';
  writeFileSync(f.receiptPath, JSON.stringify(receipt));
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /STRUCTURAL_RECEIPT_MISMATCH/);
});

test('structured hostile evidence requires a complete successful summary', async () => {
  const { verifyEvidenceEvents } = await import('../scripts/check-recovery-root-update.ts');
  const events = [
    {
      type: 'test:pass',
      data: { name: 'TCB semantic LOC is invariant to source layout and comments', nesting: 0 },
    },
    {
      type: 'test:pass',
      data: { name: 'TCB semantic span union counts containing syntax once', nesting: 0 },
    },
    { type: 'test:summary', data: { success: true } },
  ];
  assert.doesNotThrow(() =>
    verifyEvidenceEvents(events.map((event) => JSON.stringify(event)).join('\n')),
  );
  assert.doesNotThrow(() =>
    verifyEvidenceEvents(
      [
        ...events.slice(0, 2),
        { type: 'test:summary', data: { success: true, file: 'test/tcb-semantic-loc.test.ts' } },
        events[2],
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    ),
  );
  assert.throws(
    () =>
      verifyEvidenceEvents(
        events
          .slice(0, 2)
          .map((event) => JSON.stringify(event))
          .join('\n'),
      ),
    /EVIDENCE_SUMMARY_REQUIRED/,
  );
  assert.throws(
    () =>
      verifyEvidenceEvents(
        events.map((event) => JSON.stringify(event)).join('\n') + '\nnot-json-warning',
      ),
    /SyntaxError/,
  );
  assert.throws(
    () =>
      verifyEvidenceEvents(
        [...events.slice(0, 2), { type: 'test:summary', data: { success: false } }]
          .map((event) => JSON.stringify(event))
          .join('\n'),
      ),
    /EVIDENCE_SUMMARY_FAILED/,
  );
});

test('absolute semantic LOC oracle rejects systematic undercounting', async () => {
  const { assertSemanticLocOracle } = await import('../scripts/check-recovery-root-update.ts');
  const correct = { 'function-control-flow': 5, 'class-method': 3, 'type-only': 0 };
  assert.doesNotThrow(() => assertSemanticLocOracle(correct));
  assert.throws(
    () => assertSemanticLocOracle({ ...correct, 'function-control-flow': 0 }),
    /SEMANTIC_LOC_ORACLE_MISMATCH/,
  );
  assert.throws(
    () => assertSemanticLocOracle({ ...correct, 'class-method': 2 }),
    /SEMANTIC_LOC_ORACLE_MISMATCH/,
  );
  assert.throws(
    () => assertSemanticLocOracle({ ...correct, omitted: 0 }),
    /SEMANTIC_LOC_ORACLE_SCOPE/,
  );
});

test('trusted comparison rejects reporter-forged admitted status with omitted scopes or growth', async () => {
  const { reconcileRootReports } = await import('../scripts/check-recovery-root-update.ts');
  const scope = {
    id: 'fixture',
    scope_sha256: 'a'.repeat(64),
    hybrid_closure_semantic_loc: 1,
    external_module_imports: [],
    symbol_closure_external_symbols: [],
    symbol_closure_status: 'sound',
  };
  const baseline = {
    schema: 'overcenter-tcb-report',
    schema_version: 1,
    semantic_loc_basis: 'typescript-logical-sloc/v1',
    properties: [scope],
    compositions: [],
  };
  assert.throws(
    () =>
      reconcileRootReports(
        baseline,
        { ...baseline, properties: [], reconciliation: { admitted: true } },
        baseline,
      ),
    /TCB_SCOPE/,
  );
  assert.throws(
    () =>
      reconcileRootReports(
        baseline,
        {
          ...baseline,
          properties: [{ ...scope, hybrid_closure_semantic_loc: 2 }],
          reconciliation: { admitted: true },
        },
        baseline,
      ),
    /TCB_GROWTH/,
  );
  assert.throws(
    () =>
      reconcileRootReports(
        baseline,
        { ...baseline, properties: [{ ...scope, hybrid_closure_semantic_loc: -1 }] },
        baseline,
      ),
    /TCB_METRIC/,
  );
  assert.throws(
    () =>
      reconcileRootReports(
        baseline,
        { ...baseline, properties: [{ ...scope, external_module_imports: ['evil'] }] },
        baseline,
      ),
    /TCB_EXTERNAL/,
  );
  assert.equal(reconcileRootReports(baseline, baseline, baseline).admitted, true);
  const composition = {
    id: 'composition',
    scope_sha256: 'b'.repeat(64),
    properties: ['fixture'],
    hybrid_union_semantic_loc: 1,
  };
  const composed = { ...baseline, compositions: [composition] };
  assert.throws(
    () =>
      reconcileRootReports(
        composed,
        { ...composed, compositions: [{ ...composition, properties: [] }] },
        composed,
      ),
    /TCB_COMPOSITION_MEMBERSHIP/,
  );
  assert.throws(
    () =>
      reconcileRootReports(
        baseline,
        { ...baseline, properties: [{ ...scope, symbol_closure_status: 'unsound' }] },
        { ...baseline, properties: [{ ...scope, require_sound_symbol_closure: true }] },
      ),
    /TCB_SYMBOL_CLOSURE/,
  );
});

for (const path of ['package.json', 'scripts/run-unit-tests.ts', 'scripts/lint.sh']) {
  test(`rejects ${path} changes before executing candidate tooling`, (t) => {
    const f = fixture(t);
    f.put(path, 'skip checks');
    f.git('add', '.');
    f.git('commit', '--amend', '-qm', 'hostile');
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.throws(() => readFileSync(join(f.output, 'verification.json')));
  });
}
