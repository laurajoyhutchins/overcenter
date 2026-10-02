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

import {
  assertExtractedFourByFourContract,
  assertSemanticKernelProjectionSource,
  extractFourByFourSourceContract,
  loadFourByFourSourceContract,
  verifyFourByFourSourceContract,
} from './support/4x4-source-contract.ts';

const ROOT = process.cwd();
const ENGINE = resolve(ROOT, 'src/authority/engine.ts');
const PROJECTION = resolve(ROOT, 'src/authority/effect-history-projection.ts');
const FORMAL = resolve(ROOT, 'docs/migrations/4x4-strangler/formal');
const TLA_VERSION = '1.7.4';
const TLA_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const LEAN_VERSION = '4.23.0';
const LEAN_SHA256 = 'ecd028d6f642b61b451c8687aeeb24dd53789fbfdcb7d4adb8f5cf60eb2022ba';

function source(): string {
  return readFileSync(ENGINE, 'utf8');
}

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

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function download(url: string, path: string): void {
  if (existsSync(path)) return;
  run('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', path, url]);
}

function mutatedContract(sourceText: string) {
  const directory = mkdtempSync(resolve(ROOT, 'test/.4x4-boundary-'));
  const path = join(directory, 'engine.ts');
  try {
    writeFileSync(path, sourceText, 'utf8');
    return extractFourByFourSourceContract(path, ROOT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  assert.equal(await fileSha256(leanArchive), LEAN_SHA256);
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
  assert.equal(await fileSha256(tlaJar), TLA_SHA256);

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
}

test('4x4 contract is bound to the exact production source identity', () => {
  verifyFourByFourSourceContract(ROOT);
});

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

test('4x4 extractor rejects semantic mutations to admission and release', () => {
  const expected = loadFourByFourSourceContract(ROOT);
  const original = source();
  const admissionMutation = original.replace(/\beffectAdmissionDecision\s*\(/, 'Boolean(');
  assert.notEqual(admissionMutation, original);
  assert.throws(
    () => assertExtractedFourByFourContract(mutatedContract(admissionMutation), expected),
    /FOUR_BY_FOUR_SOURCE_CALL_MISSING:admission:effectAdmissionDecision/,
  );

  const releaseMutation = original.replace(/'effect-release\.json'\s*:/, "'unknown-release.json':");
  assert.notEqual(releaseMutation, original);
  assert.throws(
    () => assertExtractedFourByFourContract(mutatedContract(releaseMutation), expected),
    /FOUR_BY_FOUR_SOURCE_LITERAL_MISSING:release:effect-release\.json/,
  );
});

test('4x4 extractor fails closed on nested executable control flow', () => {
  const original = source();
  const nestedMutation = original.replace(
    /(\bbeginEffect\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{)/,
    '$1\n    const hidden = () => true;',
  );
  assert.notEqual(nestedMutation, original);
  assert.throws(
    () => mutatedContract(nestedMutation),
    /FOUR_BY_FOUR_SOURCE_UNSUPPORTED_NESTED_EXECUTABLE/,
  );
});

const hostedExactHead =
  process.env.GITHUB_ACTIONS === 'true' && Number(process.env.GITHUB_RUN_ATTEMPT ?? '1') > 1;
const formalRequested = hostedExactHead || process.env.OVERCENTER_RUN_4X4_FORMAL === '1';

test(
  '4x4 Lean and TLA+ refinement checks pass on exact-head evidence runs',
  { skip: !formalRequested },
  checkFormalModels,
);
