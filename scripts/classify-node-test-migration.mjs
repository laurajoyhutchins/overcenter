import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

async function filesUnder(directory) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(relative));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
}

function names(pattern, source) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

const all = await filesUnder('lib');
const testLike = all.filter((path) => /\.(?:test|spec)\.js$/.test(path));
const rows = [];
for (const path of testLike.sort()) {
  const source = await readFile(new URL(path, root), 'utf8');
  const exportedRunners = names(/export\s+async\s+function\s+(run[A-Za-z0-9_$]*Tests)\s*\(/g, source);
  rows.push({
    path,
    native_node_test: /from\s+['"]node:test['"]/.test(source),
    exported_runners: exportedRunners,
    nested_test_helper: /async\s+function\s+test\s*\(\s*name\s*,\s*fn\s*\)/.test(source),
    top_level_run_helper: /(?:async\s+)?function\s+run\s*\(\s*name\s*,\s*fn\s*\)/.test(source),
    results_push_run: /results\.push\s*\(\s*await\s+run\s*\(/.test(source),
    awaited_test_calls: (source.match(/await\s+test\s*\(/g) || []).length,
    direct_named_test_functions: names(/(?:async\s+)?function\s+(test[A-Z][A-Za-z0-9_$]*)\s*\(/g, source),
    spec_suffix: path.endsWith('.spec.js'),
  });
}

const embedded = [];
for (const path of all.filter((path) => !/\.(?:test|spec)\.js$/.test(path))) {
  const source = await readFile(new URL(path, root), 'utf8');
  const runners = names(/export\s+async\s+function\s+(run[A-Za-z0-9_$]*Tests)\s*\(/g, source);
  if (runners.length) embedded.push({ path, exported_runners: runners });
}

const summary = {
  schema: 'node-test-migration-classification-v1',
  test_file_count: rows.length,
  native_file_count: rows.filter((row) => row.native_node_test).length,
  legacy_file_count: rows.filter((row) => !row.native_node_test).length,
  spec_file_count: rows.filter((row) => row.spec_suffix).length,
  embedded_runner_count: embedded.length,
};

console.log(JSON.stringify({ summary, rows, embedded }, null, 2));
