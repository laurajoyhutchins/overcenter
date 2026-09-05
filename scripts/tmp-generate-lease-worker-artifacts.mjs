import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function replaceExact(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one exact match, found ${count}`);
  return source.replace(before, after);
}

async function rewrite(path, transform) {
  const current = await readFile(path, 'utf8');
  const next = transform(current);
  if (next !== current) await writeFile(path, next);
}

await rewrite('src/semantic/semantic-command-descriptors.ts', (source) => {
  source = replaceExact(
    source,
    "    githubApplyChangesetSchema,\n    'advanced',\n    WORKER_AND_MCP_EXPOSURE,",
    "    githubApplyChangesetSchema,\n    'advanced',\n    INTERNAL_EXPOSURE,",
    'github.apply_changeset exposure',
  );
  source = replaceExact(
    source,
    "    githubApplyTextReplacementsSchema,\n    'advanced',\n    WORKER_AND_MCP_EXPOSURE,",
    "    githubApplyTextReplacementsSchema,\n    'advanced',\n    INTERNAL_EXPOSURE,",
    'github.apply_text_replacements exposure',
  );
  return source;
});

await rewrite('scripts/verify-semantic-command-descriptors.test.mjs', (source) => {
  source = replaceExact(
    source,
    "const expected = ['github.pull_request.mark_ready', 'github.release.create', 'orchestration.diagnose', 'production.promote', 'project.advance', 'project.amend', 'project.define', 'project.inspect', 'release.publish', 'work.settle'];",
    "const expected = ['github.apply_changeset', 'github.apply_text_replacements', 'github.pull_request.mark_ready', 'github.release.create', 'orchestration.diagnose', 'production.promote', 'project.advance', 'project.amend', 'project.define', 'project.inspect', 'release.publish', 'work.settle'];",
    'descriptor inventory',
  );
  source = replaceExact(
    source,
    "const expectedSurface = new Map([\n  ['github.pull_request.mark_ready', 'advanced'],",
    "const expectedSurface = new Map([\n  ['github.apply_changeset', 'advanced'],\n  ['github.apply_text_replacements', 'advanced'],\n  ['github.pull_request.mark_ready', 'advanced'],",
    'descriptor surfaces',
  );
  source = replaceExact(
    source,
    "const expectedExposure = new Map([\n  ['github.pull_request.mark_ready', { worker:true, mcp:false }],",
    "const expectedExposure = new Map([\n  ['github.apply_changeset', { worker:true, mcp:false }],\n  ['github.apply_text_replacements', { worker:true, mcp:false }],\n  ['github.pull_request.mark_ready', { worker:true, mcp:false }],",
    'descriptor exposure fixture',
  );
  return source;
});

const tsc = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.semantic.runtime.json'], { stdio:'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
await copyFile('dist/lib/semantic-command-descriptors.js', 'lib/semantic-command-descriptors.js');

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
