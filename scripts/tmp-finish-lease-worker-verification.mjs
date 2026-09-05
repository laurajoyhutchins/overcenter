import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function replaceExact(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one exact match, found ${count}`);
  return source.replace(before, after);
}

const testPath = 'lib/github-lease-scoped-changeset.test.js';
let testSource = await readFile(testPath, 'utf8');
testSource = replaceExact(
  testSource,
  "import { createOrchestrationAdvanceService } from 'lib/orchestration-advance.js';\n",
  "import { createOrchestrationAdvanceService } from 'lib/orchestration-advance.js';\nimport { applyGithubLeaseScopedTextReplacements } from 'lib/github-worker-mutations.js';\n",
  'static text replacement import',
);
for (const label of ['lease-scoped text replacements bind source read to the same workspace observation as mutation', 'text replacement refuses stale content when workspace advances after exact read']) {
  const marker = `results.push(await run('${label}',async()=>{\n    const {applyGithubLeaseScopedTextReplacements}=await import('lib/github-worker-mutations.js');\n`;
  const replacement = `results.push(await run('${label}',async()=>{\n`;
  testSource = replaceExact(testSource, marker, replacement, `${label} dynamic import`);
}
await writeFile(testPath, testSource);

const classificationsPath = '.contract-evidence/classifications.json';
const classifications = JSON.parse(await readFile(classificationsPath, 'utf8'));
for (const command of ['github.apply_changeset', 'github.apply_text_replacements']) {
  const key = `semantic-command:${command}#input`;
  if (classifications.candidates[key]) throw new Error(`${key} is already classified`);
  classifications.candidates[key] = {
    logical_contract: `${command}.input`,
    significance: 'public',
    semver_kind: 'semantic-command-contract',
    lifecycle: 'current',
  };
}
const orderedCandidates = Object.fromEntries(Object.entries(classifications.candidates).sort(([a],[b]) => a.localeCompare(b)));
await writeFile(classificationsPath, `${JSON.stringify({ ...classifications, candidates: orderedCandidates }, null, 2)}\n`);

const evidence = spawnSync(process.execPath, [
  'scripts/contract-evidence/cli.mjs', 'generate',
  '--repo-root', '.',
  '--config', 'scripts/contract-evidence/overcenter/config.mjs',
  '--catalog', 'generated/contracts/catalog.json',
  '--docs', 'docs/generated/data-contracts.md',
  '--atlas', 'docs/generated/data-contract-authority-atlas.md',
], { stdio:'inherit' });
if (evidence.status !== 0) process.exit(evidence.status ?? 1);

const verify = spawnSync('npm', ['run', 'verify'], { stdio:'inherit', shell:process.platform === 'win32' });
if (verify.status !== 0) process.exit(verify.status ?? 1);
