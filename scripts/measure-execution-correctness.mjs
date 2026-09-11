import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SOURCE_ROOTS = ['src', 'lib', 'api', 'scripts'];
const TEST_MARKERS = [
  /(^|[./])test(?:s)?([./]|$)/i,
  /(?:^|[./])[^/]*(?:test|spec)\\.[cm]?[jt]sx?$/i,
];
const EXECUTION_MARKERS = [
  'lease',
  'authority',
  'evidence',
  'mutation-certainty',
  'mutation_certainty',
  'settlement',
  'receipt',
  'recovery',
  'reconcile',
  'orchestration',
  'execution',
  'operation-state',
  'operation_state',
  'proof',
  'project-transition',
  'project_transition',
  'project-advance',
  'production',
  'promotion',
  'materialization',
  'changeset',
  'release',
  'portfolio',
  'work-lifecycle',
  'work-settle',
];
const PROVIDER_ROOTS = ['github', 'gcp', 'cloud-run', 'cloudrun', 'provider', 'project-transition'];
const GENERIC_PROTOCOL_MARKERS = [
  'lease',
  'settle',
  'recovery',
  'may_have_mutated',
  'mutation_certainty',
  'idempotency',
  'evidence',
  'execution authority',
  'execution_authority',
];
const LIFECYCLE_TERMS = [
  'prepared',
  'executing',
  'indeterminate',
  'uncertain',
  'confirmed',
  'succeeded',
  'completed',
  'settled',
  'reconciled',
  'abandoned',
  'escalated',
  'rejected',
  'no_effect',
  'failed',
];
const COMPATIBILITY_MARKERS = [
  'legacy',
  'compat',
  'deprecated',
  'migration',
  'fallback',
  'bridge',
  'transition-binding',
];

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function toFilesystemPath(root) {
  if (root instanceof URL) return fileURLToPath(root);
  if (typeof root === 'string') return root;
  return process.cwd();
}

async function walk(root, relative = '') {
  const directory = path.join(root, relative);
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(root, child));
    } else if (entry.isFile()) {
      files.push(normalizePath(child));
    }
  }
  return files;
}

function isTestFile(relative) {
  return TEST_MARKERS.some((marker) => marker.test(relative));
}

function isExecutionFile(relative) {
  const lower = relative.toLowerCase();
  return EXECUTION_MARKERS.some((marker) => lower.includes(marker));
}

function isProviderFile(relative) {
  const parts = relative.toLowerCase().split('/');
  return PROVIDER_ROOTS.some((marker) => parts.includes(marker)) ||
    /(?:github|gcp|cloud.?run|provider|project-transition)/i.test(path.basename(relative));
}

function isGeneratedMirror(relative, allFiles) {
  if (!relative.startsWith('lib/') || !relative.endsWith('.js')) return false;
  const basename = path.basename(relative, '.js');
  return allFiles.some((candidate) =>
    candidate.startsWith('src/') &&
    path.basename(candidate, path.extname(candidate)) === basename &&
    /\.(?:ts|tsx)$/.test(candidate),
  );
}

function countText(text) {
  return {
    lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function hasAny(text, markers) {
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker.toLowerCase()));
}

function countLifecycleModels(records) {
  let count = 0;
  for (const { relative, text } of records) {
    const lower = text.toLowerCase();
    const matched = LIFECYCLE_TERMS.filter((term) => lower.includes(term)).length;
    const declared = /(?:type|enum|const|interface|check|transition|status|lifecycle|state)/i.test(lower);
    if (matched >= 3 && declared && isExecutionFile(relative)) count += 1;
  }
  return count;
}

function countActiveTables(records) {
  const tables = new Set();
  const tablePattern = /(?:from|into|update|table)\s+["']?([a-z][a-z0-9_]*)/gi;
  for (const { text } of records) {
    for (const match of text.matchAll(tablePattern)) {
      const table = match[1];
      if (table && /(?:execution|operation|proof|lease|receipt|evidence|orchestration|run|work|authority)/i.test(table)) {
        tables.add(table);
      }
    }
  }
  return [...tables].sort();
}

export async function measureExecutionCorrectness({ root = process.cwd(), sourceRevision = null } = {}) {
  const filesystemRoot = toFilesystemPath(root);
  const allFiles = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    allFiles.push(...await walk(filesystemRoot, sourceRoot));
  }

  const records = [];
  for (const relative of allFiles) {
    if (isGeneratedMirror(relative, allFiles)) continue;
    const absolute = path.join(filesystemRoot, relative);
    const text = await readFile(absolute, 'utf8');
    records.push({ relative, text });
  }

  const production = records.filter(({ relative }) =>
    !isTestFile(relative) && isExecutionFile(relative),
  );
  const tests = records.filter(({ relative }) =>
    isTestFile(relative) && isExecutionFile(relative),
  );

  const sum = (items) => items.reduce((total, item) => {
    const { lines, bytes } = countText(item.text);
    return { lines: total.lines + lines, bytes: total.bytes + bytes };
  }, { lines: 0, bytes: 0 });

  const productionSize = sum(production);
  const testSize = sum(tests);
  const leases = production.filter(({ relative }) => /lease|lock/i.test(relative));
  const recoveries = production.filter(({ relative }) => /recover|reconcil|retry/i.test(relative));
  const settlements = production.filter(({ relative }) => /settle|receipt|finish/i.test(relative));
  const certainty = production.filter(({ relative, text }) =>
    /mutation[-_]certainty|may_have_mutated|confirmed_mutated|definitely_not_mutated/i.test(relative) ||
    /may_have_mutated|confirmed_mutated|definitely_not_mutated/i.test(text),
  );
  const providerProtocol = production.filter(({ relative, text }) =>
    isProviderFile(relative) && hasAny(text, GENERIC_PROTOCOL_MARKERS),
  );
  const compatibility = production.filter(({ relative }) =>
    COMPATIBILITY_MARKERS.some((marker) => relative.toLowerCase().includes(marker)),
  );

  return {
    source_revision: sourceRevision,
    production_lines: productionSize.lines,
    production_bytes: productionSize.bytes,
    test_lines: testSize.lines,
    test_bytes: testSize.bytes,
    lease_implementations: leases.length,
    recovery_implementations: recoveries.length,
    settlement_implementations: settlements.length,
    mutation_certainty_implementations: certainty.length,
    provider_generic_protocol_implementations: providerProtocol.length,
    compatibility_modules: compatibility.length,
    lifecycle_models: countLifecycleModels(records),
    active_correctness_tables: countActiveTables(records),
  };
}

async function main() {
  const json = process.argv.includes('--json');
  const result = await measureExecutionCorrectness({
    root: process.cwd(),
    sourceRevision: process.env.GITHUB_SHA ?? null,
  });
  process.stdout.write(json ? JSON.stringify(result) + '\\n' : JSON.stringify(result, null, 2) + '\\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
