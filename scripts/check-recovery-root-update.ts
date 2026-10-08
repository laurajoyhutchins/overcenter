import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSourceVerificationProfile } from '../src/source/source-verification-profile.ts';
import {
  readRootAuthorization,
  rootDigest,
  rootGit,
  verifyRootUpdate,
} from './verify-recovery-root-update.ts';

function fail(code: string): never {
  throw new Error(`RECOVERY_ROOT_UPDATE_${code}`);
}

function reportObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('TCB_REPORT_SHAPE');
  return value as Record<string, unknown>;
}

function reportStrings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0) ||
    new Set(value).size !== value.length
  )
    fail('TCB_REPORT_STRINGS');
  return (value as string[]).toSorted();
}

export function reconcileRootReports(
  baselineValue: unknown,
  candidateValue: unknown,
  acceptedValue: unknown,
) {
  const baseline = reportObject(baselineValue);
  const candidate = reportObject(candidateValue);
  const accepted = reportObject(acceptedValue);
  for (const report of [baseline, candidate, accepted]) {
    if (report.schema !== 'overcenter-tcb-report' || report.schema_version !== 1)
      fail('TCB_REPORT_SCHEMA');
  }
  if (
    baseline.semantic_loc_basis !== 'typescript-logical-sloc/v1' ||
    candidate.semantic_loc_basis !== baseline.semantic_loc_basis
  )
    fail('TCB_REPORT_BASIS');
  const rows = (report: Record<string, unknown>, field: string) => {
    const values = report[field];
    if (!Array.isArray(values)) fail('TCB_SCOPE_SET');
    const result = new Map<string, Record<string, unknown>>();
    for (const value of values) {
      const row = reportObject(value);
      if (
        typeof row.id !== 'string' ||
        !row.id ||
        result.has(row.id) ||
        typeof row.scope_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.scope_sha256)
      )
        fail('TCB_SCOPE_SET');
      result.set(row.id, row);
    }
    return result;
  };
  const deltas = ['properties', 'compositions'].flatMap((field) => {
    const reference = rows(accepted, field);
    const before = rows(baseline, field);
    const after = rows(candidate, field);
    const ids = [...reference.keys()].sort();
    if (
      (field === 'properties' && ids.length === 0) ||
      JSON.stringify(ids) !== JSON.stringify([...before.keys()].sort()) ||
      JSON.stringify(ids) !== JSON.stringify([...after.keys()].sort())
    )
      fail('TCB_SCOPE_SET');
    return ids.map((id) => {
      const expected = reference.get(id);
      const base = before.get(id);
      const next = after.get(id);
      if (
        !expected ||
        !base ||
        !next ||
        base.scope_sha256 !== expected.scope_sha256 ||
        next.scope_sha256 !== expected.scope_sha256
      )
        fail('TCB_SCOPE_CHANGED');
      const metric =
        field === 'properties' ? 'hybrid_closure_semantic_loc' : 'hybrid_union_semantic_loc';
      const baseLoc = base[metric];
      const nextLoc = next[metric];
      if (
        typeof baseLoc !== 'number' ||
        !Number.isSafeInteger(baseLoc) ||
        baseLoc < 0 ||
        typeof nextLoc !== 'number' ||
        !Number.isSafeInteger(nextLoc) ||
        nextLoc < 0
      )
        fail('TCB_METRIC_INVALID');
      if (nextLoc > baseLoc) fail(`TCB_GROWTH:${id}`);
      if (field === 'properties') {
        for (const key of ['external_module_imports', 'symbol_closure_external_symbols']) {
          const oldValues = new Set(reportStrings(base[key]));
          if (reportStrings(next[key]).some((entry) => !oldValues.has(entry)))
            fail(`TCB_EXTERNAL_GROWTH:${id}`);
        }
        if (
          expected.require_sound_symbol_closure === true &&
          next.symbol_closure_status !== 'sound'
        )
          fail(`TCB_SYMBOL_CLOSURE_UNSOUND:${id}`);
      } else {
        for (const row of [base, next]) {
          if (
            JSON.stringify(reportStrings(row.properties)) !==
            JSON.stringify(reportStrings(expected.properties))
          )
            fail('TCB_COMPOSITION_MEMBERSHIP');
        }
      }
      return {
        kind: field,
        id,
        baseline_semantic_loc: baseLoc,
        candidate_semantic_loc: nextLoc,
        delta_semantic_loc: nextLoc - baseLoc,
      };
    });
  });
  // No candidate-supplied admission boolean participates in this decision.
  return { admitted: true, semantic_loc_basis: 'typescript-logical-sloc/v1', deltas };
}

const evidenceTests = [
  'TCB semantic LOC is invariant to source layout and comments',
  'TCB semantic span union counts containing syntax once',
];

const expectedSemanticLocOracle = {
  'function-control-flow': 5,
  'class-method': 3,
  'type-only': 0,
} as const;

// Absolute expectations are independent of candidate TCB reports.
export function assertSemanticLocOracle(value: unknown): void {
  const actual = reportObject(value);
  if (
    JSON.stringify(Object.keys(actual).sort()) !==
    JSON.stringify(Object.keys(expectedSemanticLocOracle).sort())
  )
    fail('SEMANTIC_LOC_ORACLE_SCOPE');
  for (const [name, expected] of Object.entries(expectedSemanticLocOracle)) {
    if (actual[name] !== expected) fail(`SEMANTIC_LOC_ORACLE_MISMATCH:${name}`);
  }
}

const semanticLocOracleSource = `
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API } from 'typescript/unstable/sync';
import { logicalSemanticLoc } from './src/analysis/tcb-semantic-loc.ts';

const root = mkdtempSync(join(tmpdir(), 'overcenter-semantic-oracle-'));
const files = {
  'function-control-flow': 'export function trusted(x: number) { const y = x + 1; if (y > 4) { return y; } return 0; }',
  'class-method': 'class Trusted { run() { return 1; } }',
  'type-only': 'interface Shape { size: number } type Alias = string;',
};
let api;
let snapshot;
try {
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, name + '.ts'), source);
  }
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, target: 'ES2023' },
    files: Object.keys(files).map(name => name + '.ts'),
  }));
  api = new API({ cwd: root });
  snapshot = api.updateSnapshot({ openProject: 'tsconfig.json' });
  const measured = {};
  for (const name of Object.keys(files)) {
    const path = join(root, name + '.ts');
    const source = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
    if (!source) throw new Error('RECOVERY_ROOT_ORACLE_SOURCE_MISSING:' + name);
    measured[name] = logicalSemanticLoc(source);
  }
  process.stdout.write('OVERCENTER_ROOT_ORACLE_JSON=' + JSON.stringify(measured) + '\\n');
} finally {
  snapshot?.dispose();
  api?.close();
  rmSync(root, { recursive: true, force: true });
}
`;

export function verifyEvidenceEvents(log: string): void {
  const passed = new Set<string>();
  let summaries = 0;
  for (const line of log.split('\n').filter(Boolean)) {
    const event = reportObject(JSON.parse(line));
    const data = reportObject(event.data);
    if (event.type === 'test:fail') fail('EVIDENCE_TEST_FAILED');
    if (event.type === 'test:summary') {
      summaries += 1;
      if (data.success !== true) fail('EVIDENCE_SUMMARY_FAILED');
    }
    if (event.type === 'test:pass' && evidenceTests.includes(String(data.name))) {
      if (data.skip || data.todo || data.nesting !== 0 || passed.has(String(data.name)))
        fail('EVIDENCE_COMPLETION_INVALID');
      passed.add(String(data.name));
    }
  }
  if (summaries !== 1) fail('EVIDENCE_SUMMARY_REQUIRED');
  if (passed.size !== evidenceTests.length) fail('EVIDENCE_REQUIRED_TESTS_NOT_COMPLETED');
}

function tracked(repo: string): string[] {
  return rootGit(repo, 'ls-files', '-z').split('\0').filter(Boolean).sort();
}

function contentDigest(repo: string): string {
  const manifest = tracked(repo).map((path) => [path, rootDigest(readFileSync(join(repo, path)))]);
  // Refuse added source as well as edits to tracked bytes. Tool installations are ignored by Git.
  const extras = rootGit(repo, 'ls-files', '--others', '--exclude-standard', '-z');
  return rootDigest(JSON.stringify({ manifest, extras }));
}

function assertExactCheckout(repo: string, revision: string): void {
  if (rootGit(repo, 'rev-parse', 'HEAD') !== revision) fail('CHECKOUT_REVISION_MISMATCH');
  rootGit(repo, 'diff', '--exit-code', 'HEAD', '--');
  if (rootGit(repo, 'ls-files', '--others', '--exclude-standard', '-z'))
    fail('CHECKOUT_UNTRACKED_SOURCE');
}

function checkEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'LANG',
    'LC_ALL',
    'CI',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // No workflow token, owner credential, NODE_OPTIONS, or candidate-selected commands reach checks.
  return env;
}

function dependencyDigest(directory: string): string {
  const walk = (path: string): unknown[] =>
    readdirSync(path)
      .sort()
      .map((name) => {
        const file = join(path, name);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) return [name, 'link', readlinkSync(file)];
        if (stat.isDirectory()) return [name, walk(file)];
        return [name, stat.mode, rootDigest(readFileSync(file))];
      });
  return rootDigest(JSON.stringify(walk(directory)));
}

export function checkRootUpdate(
  accepted: string,
  candidate: string,
  structuralPath: string,
  output: string,
) {
  mkdirSync(output, { recursive: true });
  const verificationPath = join(output, 'verification.json');
  rmSync(verificationPath, { force: true });
  const supplied = JSON.parse(readFileSync(structuralPath, 'utf8')) as Record<string, unknown>;
  const authKeys = [
    'schema',
    'repository_full_name',
    'base_sha',
    'candidate_sha',
    'candidate_tree_sha',
    'writable_paths',
    'reason',
    'authorized_by',
    'evidence_sha',
    'evidence_path',
    'evidence_blob_sha',
  ];
  const authorization = readRootAuthorization({
    ...Object.fromEntries(authKeys.map((key) => [key, supplied[key]])),
    schema: 'overcenter-recovery-root-update-authorization/v1',
  });
  const structural = verifyRootUpdate(authorization, candidate);
  if (
    JSON.stringify(Object.keys(supplied).sort()) !==
      JSON.stringify(Object.keys(structural).sort()) ||
    Object.entries(structural).some(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(supplied[key]),
    )
  )
    fail('STRUCTURAL_RECEIPT_MISMATCH');
  assertExactCheckout(accepted, structural.base_sha);
  assertExactCheckout(candidate, structural.candidate_sha);
  const acceptedBefore = contentDigest(accepted);
  const candidateBefore = contentDigest(candidate);
  const runtimePin = readFileSync(join(accepted, '.node-version'), 'utf8').trim();
  if (process.version !== `v${runtimePin}`) fail('NODE_RUNTIME_MISMATCH');
  const nodeDigest = rootDigest(readFileSync(process.execPath));
  const dependencyBefore = [accepted, candidate].map((repo) =>
    dependencyDigest(join(repo, 'node_modules')),
  );
  const profile = readSourceVerificationProfile(accepted, structural.base_sha).profile;
  const packageText = readFileSync(join(accepted, 'package.json'), 'utf8');
  if (packageText !== readFileSync(join(candidate, 'package.json'), 'utf8')) fail('PACKAGE_DRIFT');
  const dependencies = (JSON.parse(packageText) as { devDependencies: Record<string, string> })
    .devDependencies;
  const tools = [accepted, candidate].map((repo) =>
    Object.entries(dependencies).map(([name, version]) => {
      const bytes = readFileSync(join(repo, 'node_modules', name, 'package.json'));
      if ((JSON.parse(bytes.toString()) as { version: string }).version !== version)
        fail('TOOLCHAIN_VERSION_MISMATCH');
      return { name, version, package_sha256: rootDigest(bytes) };
    }),
  );
  const scratch = mkdtempSync(join(tmpdir(), 'overcenter-root-verification-'));
  const worktrees: string[] = [];
  const snapshot = (name: string, sha: string) => {
    const dir = join(scratch, name);
    rootGit(candidate, 'worktree', 'add', '--detach', dir, sha);
    worktrees.push(dir);
    symlinkSync(join(accepted, 'node_modules'), join(dir, 'node_modules'), 'dir');
    return dir;
  };
  const env = checkEnvironment();
  let checkIndex = 0;
  const run = (name: string, cwd: string, executable: string, args: string[]) => {
    const result = spawnSync(executable, args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
    const log = `${name.replaceAll('/', '-')}-${checkIndex++}.log`;
    const stdoutLog = `${log}.stdout`;
    const stderrLog = `${log}.stderr`;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const bytes = `${stdout}${stderr}`;
    writeFileSync(join(output, stdoutLog), stdout);
    writeFileSync(join(output, stderrLog), stderr);
    writeFileSync(join(output, log), bytes);
    if (result.error || result.status !== 0) fail(`CHECK_FAILED:${name}:${log}`);
    return {
      name,
      executable,
      argv: args,
      exit_code: result.status,
      log,
      log_sha256: rootDigest(bytes),
      stdout_log: stdoutLog,
      stdout_sha256: rootDigest(stdout),
      stderr_log: stderrLog,
      stderr_sha256: rootDigest(stderr),
    };
  };
  const reportDigest = (file: string, logical = false, baseline = false) => {
    const bytes = readFileSync(file);
    const value = JSON.parse(bytes.toString()) as {
      schema: string;
      semantic_loc_basis?: string;
      reconciliation?: { admitted?: boolean; baseline_revision?: string };
    };
    if (
      value.schema !== 'overcenter-tcb-report' ||
      (logical && value.semantic_loc_basis !== 'typescript-logical-sloc/v1') ||
      (baseline &&
        (value.reconciliation?.admitted !== true ||
          value.reconciliation.baseline_revision !== structural.base_sha))
    )
      fail('TCB_REPORT_INVALID');
    return {
      file: file.slice(output.length + 1),
      sha256: rootDigest(bytes),
      semantic_loc_basis: value.semantic_loc_basis ?? 'accepted-reporter/unspecified',
    };
  };
  try {
    const projection = snapshot('accepted-projection', structural.candidate_sha);
    // Freeze drivers and all their repository authority imports, together with the accepted tests.
    // These paths are an observation projection, never described as the exact candidate tree.
    const roots = [
      'scripts',
      'src/source',
      'src/digest.ts',
      'src/validation.ts',
      'package.json',
      'biome.json',
      'tsconfig.json',
      '.overcenter',
      ...profile.baseline_test_roots,
    ];
    const acceptedFiles = rootGit(
      accepted,
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      structural.base_sha,
    )
      .split('\0')
      .filter(Boolean);
    const overlay = (overlayRoots: string[], preserveReporter = false) =>
      acceptedFiles
        .filter((path) => overlayRoots.some((root) => path === root || path.startsWith(`${root}/`)))
        .filter((path) => !preserveReporter || path !== 'scripts/report-tcb.ts')
        .sort()
        .map((path) => {
          const bytes = execFileSync(
            'git',
            ['-C', accepted, 'show', `${structural.base_sha}:${path}`],
            { maxBuffer: 32 * 1024 * 1024 },
          );
          mkdirSync(dirname(join(projection, path)), { recursive: true });
          writeFileSync(join(projection, path), bytes);
          return { path, sha256: rootDigest(bytes) };
        });
    const manifest = overlay(roots, true);
    const exact = snapshot('candidate-checks', structural.candidate_sha);
    // Candidate toolchain is installed separately; both have the immutable accepted pins.
    rmSync(join(exact, 'node_modules'));
    symlinkSync(join(candidate, 'node_modules'), join(exact, 'node_modules'), 'dir');
    const projectionBefore = contentDigest(projection);
    const exactBefore = contentDigest(exact);
    const sourceChecks = (label: string, dir: string) => [
      run(`${label}/lint`, dir, 'bash', ['scripts/lint.sh']),
      run(`${label}/typecheck`, dir, process.execPath, [
        join(dir, 'node_modules/typescript/lib/tsc.js'),
        '-p',
        'tsconfig.json',
      ]),
      run(`${label}/unit`, dir, process.execPath, [
        '--experimental-strip-types',
        'scripts/run-unit-tests.ts',
      ]),
    ];
    const tcbCheck = (label: string, dir: string, baseline: boolean) =>
      run(`${label}/tcb`, dir, process.execPath, [
        '--experimental-strip-types',
        'scripts/report-tcb.ts',
        '--output',
        join(output, `${label}-tcb.json`),
        ...(baseline ? ['--baseline', structural.base_sha] : []),
      ]);
    const acceptedChecks = sourceChecks('accepted', projection);
    if (contentDigest(projection) !== projectionBefore) fail('ACCEPTED_PROJECTION_MUTATED');
    const measurementManifest = overlay([
      'scripts/report-tcb.ts',
      'src/analysis',
      'src/architecture',
    ]);
    const measurementBefore = contentDigest(projection);
    acceptedChecks.push(tcbCheck('accepted', projection, false));
    if (contentDigest(projection) !== measurementBefore) fail('ACCEPTED_MEASUREMENT_MUTATED');
    const candidateChecks = [
      ...sourceChecks('candidate', exact),
      tcbCheck('candidate', exact, true),
    ];
    // Relative TCB reconciliation cannot detect systematic undercounting
    // by the same reporter on both baseline and candidate trees.
    let semanticLocOracleCheck: ReturnType<typeof run> | null = null;
    if (structural.writable_paths.includes('src/analysis/tcb-semantic-loc.ts')) {
      const oraclePath = join(exact, '.recovery-root-semantic-oracle.mjs');
      if (existsSync(oraclePath)) fail('SEMANTIC_LOC_ORACLE_PATH_EXISTS');
      try {
        writeFileSync(oraclePath, semanticLocOracleSource);
        semanticLocOracleCheck = run('candidate/semantic-loc-oracle', exact, process.execPath, [
          '--experimental-strip-types',
          oraclePath,
        ]);
      } finally {
        rmSync(oraclePath, { force: true });
      }
      if (!semanticLocOracleCheck) fail('SEMANTIC_LOC_ORACLE_MISSING');
      const log = readFileSync(join(output, semanticLocOracleCheck.stdout_log), 'utf8');
      const results = log
        .split('\n')
        .filter((line) => line.startsWith('OVERCENTER_ROOT_ORACLE_JSON='));
      if (results.length !== 1) fail('SEMANTIC_LOC_ORACLE_RESULT_INVALID');
      assertSemanticLocOracle(JSON.parse(results[0].slice('OVERCENTER_ROOT_ORACLE_JSON='.length)));
    }
    if (contentDigest(exact) !== exactBefore) fail('CANDIDATE_CHECK_SOURCE_MUTATED');
    const baseline = snapshot('same-reporter-baseline', structural.base_sha);
    const baselineBefore = contentDigest(baseline);
    const sameReporterCheck = run('same-reporter/baseline', baseline, process.execPath, [
      '--experimental-strip-types',
      join(exact, 'scripts/report-tcb.ts'),
      '--output',
      join(output, 'same-reporter-baseline-tcb.json'),
    ]);
    if (contentDigest(baseline) !== baselineBefore || contentDigest(exact) !== exactBefore)
      fail('BASELINE_SOURCE_MUTATED');
    const reports = [
      reportDigest(join(output, 'accepted-tcb.json')),
      reportDigest(join(output, 'candidate-tcb.json'), true, true),
      reportDigest(join(output, 'same-reporter-baseline-tcb.json'), true),
    ];
    const trustedReconciliation = reconcileRootReports(
      JSON.parse(readFileSync(join(output, 'same-reporter-baseline-tcb.json'), 'utf8')),
      JSON.parse(readFileSync(join(output, 'candidate-tcb.json'), 'utf8')),
      JSON.parse(readFileSync(join(output, 'accepted-tcb.json'), 'utf8')),
    );
    const evidence = snapshot('hostile-evidence', structural.candidate_sha);
    const evidenceBefore = contentDigest(evidence);
    const evidenceBytes = execFileSync('git', [
      '-C',
      candidate,
      'cat-file',
      'blob',
      structural.evidence_blob_sha,
    ]);
    const evidenceFile = join(evidence, structural.evidence_path);
    if (existsSync(evidenceFile)) fail('EVIDENCE_ALREADY_IN_CANDIDATE');
    mkdirSync(dirname(evidenceFile), { recursive: true });
    writeFileSync(evidenceFile, evidenceBytes);
    const eventReporter = join(scratch, 'evidence-reporter.mjs');
    const reporterSource =
      "export default async function* (events) { for await (const event of events) yield JSON.stringify(event) + '\\n'; }\n";
    writeFileSync(eventReporter, reporterSource);
    const evidenceCheck = run('evidence/hostile', evidence, process.execPath, [
      '--experimental-strip-types',
      '--test',
      `--test-reporter=${pathToFileURL(eventReporter).href}`,
      structural.evidence_path,
    ]);
    const evidenceLog = readFileSync(join(output, evidenceCheck.stdout_log), 'utf8');
    verifyEvidenceEvents(evidenceLog);
    if (readFileSync(eventReporter, 'utf8') !== reporterSource) fail('EVIDENCE_REPORTER_MUTATED');
    if (rootDigest(readFileSync(evidenceFile)) !== structural.evidence_sha256)
      fail('EVIDENCE_SOURCE_MUTATED');
    rmSync(evidenceFile);
    if (contentDigest(evidence) !== evidenceBefore) fail('EVIDENCE_CANDIDATE_MUTATED');
    assertExactCheckout(accepted, structural.base_sha);
    assertExactCheckout(candidate, structural.candidate_sha);
    const candidateAfter = contentDigest(candidate);
    if (contentDigest(accepted) !== acceptedBefore || candidateAfter !== candidateBefore)
      fail('ORIGINAL_CHECKOUT_MUTATED');
    if (
      [accepted, candidate].some(
        (repo, index) => dependencyDigest(join(repo, 'node_modules')) !== dependencyBefore[index],
      ) ||
      rootDigest(readFileSync(process.execPath)) !== nodeDigest
    )
      fail('TOOLCHAIN_MUTATED');
    const result = {
      schema: 'overcenter-recovery-root-update-verification/v1',
      structural,
      projection: {
        kind: 'candidate-with-accepted-authority-overlay',
        manifest,
        manifest_sha256: rootDigest(JSON.stringify(manifest)),
        content_sha256: projectionBefore,
        measurement_manifest: measurementManifest,
        measurement_manifest_sha256: rootDigest(JSON.stringify(measurementManifest)),
        measurement_content_sha256: measurementBefore,
      },
      toolchains: tools,
      node: process.version,
      node_executable_sha256: nodeDigest,
      installed_dependency_sha256: dependencyBefore,
      accepted_checks: acceptedChecks,
      candidate_checks: candidateChecks,
      same_reporter_check: sameReporterCheck,
      semantic_loc_oracle_check: semanticLocOracleCheck,
      trusted_tcb_reconciliation: trustedReconciliation,
      reports,
      evidence_check: evidenceCheck,
      evidence_required_tests: evidenceTests,
      evidence_event_reporter_sha256: rootDigest(reporterSource),
      candidate_content_before: candidateBefore,
      candidate_content_after: candidateAfter,
      accepted_content_sha256: acceptedBefore,
      candidate_tree_sha: structural.candidate_tree_sha,
    };
    writeFileSync(verificationPath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    for (const dir of worktrees.reverse()) rootGit(candidate, 'worktree', 'remove', '--force', dir);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [accepted, candidate, structural, output] = process.argv.slice(2);
  if (!accepted || !candidate || !structural || !output) fail('ARGUMENTS_REQUIRED');
  const result = checkRootUpdate(
    resolve(accepted),
    resolve(candidate),
    resolve(structural),
    resolve(output),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
