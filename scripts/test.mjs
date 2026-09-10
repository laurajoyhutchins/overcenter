import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { auditRepositoryTests } from './test-audit.mjs';

const root = new URL('../', import.meta.url);
const cwd = fileURLToPath(root);

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function exactRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const revision = String(result.stdout || '').trim().toLowerCase();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('test discovery requires an exact Git revision');
  }
  return revision;
}

async function javascriptFiles(directory) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await javascriptFiles(relative));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
}

run(['scripts/verify-orchestration-drive.mjs']);

const audit = await auditRepositoryTests({ root: cwd, revision: exactRevision() });
if (audit.unresolved_shape_count !== 0) {
  console.error(JSON.stringify({ schema: audit.schema, revision: audit.revision, unresolved: audit.unresolved }, null, 2));
  process.exit(1);
}
const legacyCases = audit.cases.filter((entry) => entry.kind === 'legacy_named_test');
if (legacyCases.length !== 0) {
  console.error(JSON.stringify({ schema: audit.schema, revision: audit.revision, legacy_cases: legacyCases }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ schema: audit.schema, revision: audit.revision, test_file_count: audit.test_file_count, case_count: audit.case_count, unresolved_shape_count: audit.unresolved_shape_count }));
run(['--test', ...audit.test_files]);

for (const directory of ['api', 'lib', 'mcp', 'pages']) {
  for (const file of await javascriptFiles(directory)) run(['--check', file]);
}
