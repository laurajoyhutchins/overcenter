import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { assertSemanticKernelProjectionSource } from './support/4x4-kernel-shape.ts';

const ROOT = process.cwd();
const PROJECTION = resolve(ROOT, 'src/authority/effect-history-projection.ts');
const FORMAL = resolve(ROOT, 'docs/migrations/4x4-strangler/formal');
const TLA_VERSION = '1.7.4';
const TLA_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const LEAN_VERSION = '4.23.0';
const LEAN_SHA256 = 'ecd028d6f642b61b451c8687aeeb24dd53789fbfdcb7d4adb8f5cf60eb2022ba';
const SOUFFLE_VERSION = '2.5';
const SOUFFLE_PACKAGE = 'x86_64-ubuntu-2404-souffle-2.5-Linux.deb';
const SOUFFLE_SHA512 =
  '6b86e554f6aa5abf8a8b55d8312ae37c0957c5bd6c9edeea89246db9406f645ec5e600b84fe6636b1c163da556f0da6c3d2dad46c1083413f2fcf4f95b9ac62c';

function run(command: string, args: string[], cwd = ROOT): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `FOUR_BY_FOUR_COMMAND_FAILED:${command}:${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function runStatus(command: string, args: string[], cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

async function fileHash(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function download(url: string, path: string): void {
  if (existsSync(path)) return;
  run('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', path, url]);
}

async function checkFormalModels(): Promise<void> {
  const cache = join(homedir(), '.cache', 'overcenter-research', '4x4-formal');
  mkdirSync(cache, { recursive: true });

  const leanFile = join(FORMAL, 'FourByFourEffect.lean');
  assert.doesNotMatch(readFileSync(leanFile, 'utf8'), /\b(?:sorry|admit|sorryAx)\b/);

  const leanArchive = join(cache, `lean-${LEAN_VERSION}-linux.tar.zst`);
  download(
    `https://github.com/leanprover/lean4/releases/download/v${LEAN_VERSION}/lean-${LEAN_VERSION}-linux.tar.zst`,
    leanArchive,
  );
  assert.equal(await fileHash(leanArchive, 'sha256'), LEAN_SHA256);
  const leanRoot = join(cache, `lean-${LEAN_VERSION}-linux`);
  const lean = join(leanRoot, 'bin', 'lean');
  if (!existsSync(lean)) {
    run('tar', ['--zstd', '-xf', leanArchive, '-C', cache]);
  }
  assert.match(run(lean, ['--version']), new RegExp(`version ${LEAN_VERSION}`));
  const leanOut = mkdtempSync(join(tmpdir(), 'overcenter-4x4-lean-'));
  try {
    run(lean, ['-o', join(leanOut, 'FourByFourEffect.olean'), leanFile]);
  } finally {
    rmSync(leanOut, { recursive: true, force: true });
  }

  const tlaJar = join(cache, `tla2tools-${TLA_VERSION}.jar`);
  download(
    `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar`,
    tlaJar,
  );
  assert.equal(await fileHash(tlaJar, 'sha256'), TLA_SHA256);

  const positive = run(
    'java',
    [
      '-XX:+UseParallelGC',
      '-jar',
      tlaJar,
      '-workers',
      'auto',
      '-config',
      'FourByFourEffect.cfg',
      'FourByFourEffect.tla',
    ],
    FORMAL,
  );
  assert.match(positive, /Model checking completed/);

  for (const [config, invariant] of [
    ['BrokenRecoveryCertainty.cfg', 'RecoveryCertainty'],
    ['BrokenReservationIsAuthority.cfg', 'ReservationExistenceIsAuthority'],
  ] as const) {
    const result = runStatus(
      'java',
      [
        '-XX:+UseParallelGC',
        '-jar',
        tlaJar,
        '-workers',
        'auto',
        '-config',
        config,
        'FourByFourEffect.tla',
      ],
      FORMAL,
    );
    assert.notEqual(result.status, 0, `${config} must remain a negative control`);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, new RegExp(`Invariant ${invariant} is violated`));
  }

  const suppliedSouffle =
    process.env.GITHUB_ACTIONS === 'true' ? undefined : process.env.OVERCENTER_SOUFFLE;
  let souffle = suppliedSouffle;
  if (!souffle) {
    const soufflePackage = join(cache, SOUFFLE_PACKAGE);
    download(
      `https://github.com/souffle-lang/souffle/releases/download/${SOUFFLE_VERSION}/${SOUFFLE_PACKAGE}`,
      soufflePackage,
    );
    assert.equal(await fileHash(soufflePackage, 'sha512'), SOUFFLE_SHA512);
    const souffleRoot = join(cache, `souffle-${SOUFFLE_VERSION}-ubuntu2404`);
    souffle = join(souffleRoot, 'usr', 'bin', 'souffle');
    if (!existsSync(souffle)) {
      mkdirSync(souffleRoot, { recursive: true });
      run('dpkg-deb', ['-x', soufflePackage, souffleRoot]);
    }
  }
  assert.match(run(souffle, ['--version']), new RegExp(`Version: ${SOUFFLE_VERSION}`));

  const datalog = join(FORMAL, 'EffectAdmission.dl');
  const runAdmissionCase = (
    permitAuthority: string,
    unresolved: boolean,
    executing = true,
  ): string => {
    const directory = mkdtempSync(join(tmpdir(), 'overcenter-4x4-datalog-'));
    const facts = join(directory, 'facts');
    const output = join(directory, 'output');
    mkdirSync(facts);
    mkdirSync(output);
    try {
      writeFileSync(
        join(facts, 'authority.facts'),
        'run\tobligation\trevision\tclaim\tkey\t7\tauthority\tcapability\n',
      );
      writeFileSync(
        join(facts, 'permit.facts'),
        `run\tobligation\trevision\tclaim\tkey\t7\t${permitAuthority}\tcapability\n`,
      );
      writeFileSync(join(facts, 'executing.facts'), executing ? 'run\n' : '');
      writeFileSync(join(facts, 'unresolved.facts'), unresolved ? 'run\n' : '');
      run(souffle, [datalog, '-F', facts, '-D', output]);
      return readFileSync(join(output, 'admitted.csv'), 'utf8').trim();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  assert.equal(runAdmissionCase('authority', false), 'run');
  assert.equal(runAdmissionCase('stale-authority', false), '');
  assert.equal(runAdmissionCase('authority', true), '');
  assert.equal(runAdmissionCase('authority', false, false), '');
}

test('4x4 kernel namespace is closed to four nouns and four relations', () => {
  const projection = readFileSync(PROJECTION, 'utf8');
  assert.doesNotThrow(() => {
    assertSemanticKernelProjectionSource(projection);
  });

  assert.throws(
    () =>
      assertSemanticKernelProjectionSource(
        `${projection}\nexport interface FourByFourAuthority { id: string; }\n`,
      ),
    /FOUR_BY_FOUR_KERNEL_PRIMITIVE_DRIFT:FourByFourAuthority/,
  );

  const aliasedRelation = projection.replace(
    '  requires: FourByFourRequires[];',
    '  requires: FourByFourRequires[];\n  governs: FourByFourRequires[];',
  );
  assert.notEqual(aliasedRelation, projection);
  assert.throws(
    () => assertSemanticKernelProjectionSource(aliasedRelation),
    /FOUR_BY_FOUR_KERNEL_PROJECTION_DRIFT/,
  );

  assert.doesNotThrow(() => {
    assertSemanticKernelProjectionSource(
      `${projection}\nexport interface GitHubProviderVocabulary { id: string; }\n`,
    );
  });
});

const hostedExactHead =
  process.env.GITHUB_ACTIONS === 'true' && Number(process.env.GITHUB_RUN_ATTEMPT ?? '1') > 1;
const formalRequested = hostedExactHead || process.env.OVERCENTER_RUN_4X4_FORMAL === '1';

test(
  '4x4 Lean, TLC, and Datalog refinement checks pass on exact-head evidence runs',
  { skip: !formalRequested },
  checkFormalModels,
);
