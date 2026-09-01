import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson } from './canonical.mjs';
import { compareCatalogs } from './compare.mjs';
import { compileCatalog } from './compiler.mjs';
import { renderCatalogMarkdown } from './render-markdown.mjs';

function fail(code, message, details = null) {
  const error = new Error(message);
  Object.assign(error, { code, details });
  throw error;
}

function args(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) fail('CONTRACT_CLI_INVALID', 'flags must be --name value pairs', { flag:flag ?? null });
    flags[flag.slice(2)] = value;
  }
  return { command, flags };
}

function required(flags, name) {
  const value = flags[name];
  if (!value) fail('CONTRACT_CLI_INVALID', `--${name} is required`, { field:name });
  return value;
}

function artifactPath(repoRoot, value) {
  return isAbsolute(value) ? value : join(repoRoot, value);
}

async function loadConfig(path) {
  const url = pathToFileURL(resolve(path));
  const module = await import(url.href);
  if (!module.default || typeof module.default !== 'object') fail('CONTRACT_CONFIG_INVALID', 'config module must default-export an object');
  return module.default;
}

async function compileFor(flags) {
  const repoRoot = resolve(flags['repo-root'] || '.');
  const config = await loadConfig(required(flags, 'config'));
  const allowedSemverKinds = typeof config.resolveAllowedSemverKinds === 'function'
    ? await config.resolveAllowedSemverKinds({ repoRoot })
    : undefined;
  return {
    repoRoot,
    catalog:await compileCatalog({
      repoRoot,
      discoverers:config.discoverers || [],
      classificationPath:join(repoRoot, config.classificationPath || '.contract-evidence/classifications.json'),
      allowedSemverKinds,
    }),
  };
}

async function generate(flags) {
  const { repoRoot, catalog } = await compileFor(flags);
  const catalogPath = artifactPath(repoRoot, required(flags, 'catalog'));
  const docsPath = artifactPath(repoRoot, required(flags, 'docs'));
  await writeFile(catalogPath, canonicalJson(catalog) + '\n', 'utf8');
  await writeFile(docsPath, renderCatalogMarkdown(catalog) + '\n', 'utf8');
  return { ok:true, catalog:catalogPath, docs:docsPath, summary:catalog.summary };
}

async function check(flags) {
  const { repoRoot, catalog } = await compileFor(flags);
  const catalogPath = artifactPath(repoRoot, required(flags, 'catalog'));
  const docsPath = artifactPath(repoRoot, required(flags, 'docs'));
  const expectedCatalog = canonicalJson(catalog) + '\n';
  const expectedDocs = renderCatalogMarkdown(catalog) + '\n';
  const [actualCatalog, actualDocs] = await Promise.all([
    readFile(catalogPath, 'utf8'),
    readFile(docsPath, 'utf8'),
  ]);
  const stale = [];
  if (actualCatalog !== expectedCatalog) stale.push(catalogPath);
  if (actualDocs !== expectedDocs) stale.push(docsPath);
  if (stale.length) fail('CONTRACT_GENERATED_ARTIFACT_STALE', 'generated contract evidence is stale', { stale });
  return { ok:true, summary:catalog.summary };
}

async function compare(flags) {
  const [baseSource, headSource] = await Promise.all([
    readFile(required(flags, 'base-catalog'), 'utf8'),
    readFile(required(flags, 'head-catalog'), 'utf8'),
  ]);
  const result = compareCatalogs(JSON.parse(baseSource), JSON.parse(headSource));
  if (!result.ok) fail('CONTRACT_NEW_UNCLASSIFIED', 'candidate introduces new unclassified contract identities', result);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = args(argv);
  if (command === 'generate') return generate(flags);
  if (command === 'check') return check(flags);
  if (command === 'compare') return compare(flags);
  fail('CONTRACT_CLI_INVALID', 'command must be generate, check, or compare', { command:command ?? null });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().then(
    (result) => process.stdout.write(JSON.stringify(result) + '\n'),
    (error) => {
      process.stderr.write(JSON.stringify({ ok:false, error:error?.code || 'CONTRACT_CLI_ERROR', message:error?.message, details:error?.details ?? null }) + '\n');
      process.exitCode = 1;
    },
  );
}
