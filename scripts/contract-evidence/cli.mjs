import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalJson,
  compareCatalogs,
  compileCatalog,
  renderAuthorityAtlasMarkdown,
  renderCatalogMarkdown,
} from '../../packages/contract-evidence/index.mjs';

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

function catalogReplacementPlan(path, beforeText, afterText) {
  if (beforeText === afterText) return [];
  const before = JSON.parse(beforeText);
  const after = JSON.parse(afterText);
  const replacements = [];
  const beforeIds = new Set(before.logical_contracts.map((contract) => contract.id));
  const added = after.logical_contracts.filter((contract) => !beforeIds.has(contract.id));
  if (added.length) {
    const firstAddedIndex = after.logical_contracts.findIndex((contract) => contract.id === added[0].id);
    const next = after.logical_contracts.slice(firstAddedIndex + added.length).find((contract) => beforeIds.has(contract.id));
    if (next) {
      const old = canonicalJson(next);
      replacements.push({
        path,
        old,
        new_text:`${added.map((contract) => canonicalJson(contract)).join(',')},${old}`,
        expected_count:1,
      });
    } else {
      const previous = [...after.logical_contracts.slice(0, firstAddedIndex)].reverse().find((contract) => beforeIds.has(contract.id));
      if (!previous) fail('CONTRACT_TEMP_DIFF_INVALID', 'unable to anchor added logical contract');
      const old = canonicalJson(previous);
      replacements.push({
        path,
        old,
        new_text:`${old},${added.map((contract) => canonicalJson(contract)).join(',')}`,
        expected_count:1,
      });
    }
  }
  const beforeSummary = `\"summary\":${canonicalJson(before.summary)}`;
  const afterSummary = `\"summary\":${canonicalJson(after.summary)}`;
  if (beforeSummary !== afterSummary) {
    replacements.push({ path, old:beforeSummary, new_text:afterSummary, expected_count:1 });
  }
  const afterUnclassified = new Set(after.unclassified_source_identities);
  for (const identity of before.unclassified_source_identities.filter((value) => !afterUnclassified.has(value))) {
    const leading = `${JSON.stringify(identity)},`;
    const trailing = `,${JSON.stringify(identity)}`;
    if (beforeText.includes(leading)) replacements.push({ path, old:leading, new_text:'', expected_count:1 });
    else if (beforeText.includes(trailing)) replacements.push({ path, old:trailing, new_text:'', expected_count:1 });
    else fail('CONTRACT_TEMP_DIFF_INVALID', 'unable to anchor removed unclassified identity', { identity });
  }
  return replacements;
}

function textChunks(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function lineReplacementPlan(path, beforeText, afterText) {
  if (beforeText === afterText) return [];
  const before = textChunks(beforeText);
  const after = textChunks(afterText);
  const dp = Array.from({ length:before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      ops.push({ type:'equal', text:before[i] });
      i += 1;
      j += 1;
    } else if (j < after.length && (i === before.length || dp[i][j + 1] > dp[i + 1][j])) {
      ops.push({ type:'insert', text:after[j] });
      j += 1;
    } else {
      ops.push({ type:'delete', text:before[i] });
      i += 1;
    }
  }
  const changedIndexes = ops.map((op, index) => op.type === 'equal' ? -1 : index).filter((index) => index >= 0);
  const groups = [];
  for (const index of changedIndexes) {
    const last = groups.at(-1);
    if (!last || index - last.end > 3) groups.push({ start:index, end:index });
    else last.end = index;
  }
  return groups.map(({ start, end }) => {
    const from = Math.max(0, start - 1);
    const to = Math.min(ops.length - 1, end + 1);
    const slice = ops.slice(from, to + 1);
    const old = slice.filter((op) => op.type !== 'insert').map((op) => op.text).join('');
    const newText = slice.filter((op) => op.type !== 'delete').map((op) => op.text).join('');
    if (!old) fail('CONTRACT_TEMP_DIFF_INVALID', 'line replacement lacks an old-text anchor', { path, start, end });
    return { path, old, new_text:newText, expected_count:1 };
  });
}

async function emitTemporaryReplacementPlan(repoRoot, outputs) {
  const specs = [
    ['generated/contracts/catalog.json', outputs.catalog, 'catalog'],
    ['docs/generated/data-contracts.md', outputs.docs, 'lines'],
    ['docs/generated/data-contract-authority-atlas.md', outputs.atlas, 'lines'],
  ];
  const replacements = [];
  for (const [path, generatedPath, mode] of specs) {
    const committedPath = join(repoRoot, path);
    if (resolve(committedPath) === resolve(generatedPath)) continue;
    const [before, after] = await Promise.all([
      readFile(committedPath, 'utf8'),
      readFile(generatedPath, 'utf8'),
    ]);
    replacements.push(...(mode === 'catalog'
      ? catalogReplacementPlan(path, before, after)
      : lineReplacementPlan(path, before, after)));
  }
  process.stderr.write(`CONTRACT_EVIDENCE_REPLACEMENTS=${JSON.stringify(replacements)}\n`);
}

async function generate(flags) {
  const { repoRoot, catalog } = await compileFor(flags);
  const catalogPath = artifactPath(repoRoot, required(flags, 'catalog'));
  const docsPath = artifactPath(repoRoot, required(flags, 'docs'));
  const atlasPath = artifactPath(repoRoot, required(flags, 'atlas'));
  await Promise.all([
    writeFile(catalogPath, canonicalJson(catalog) + '\n', 'utf8'),
    writeFile(docsPath, renderCatalogMarkdown(catalog) + '\n', 'utf8'),
    writeFile(atlasPath, renderAuthorityAtlasMarkdown(catalog) + '\n', 'utf8'),
  ]);
  await emitTemporaryReplacementPlan(repoRoot, { catalog:catalogPath, docs:docsPath, atlas:atlasPath });
  return { ok:true, catalog:catalogPath, docs:docsPath, atlas:atlasPath, summary:catalog.summary };
}

async function checkPrecomputed(flags) {
  const repoRoot = resolve(flags['repo-root'] || '.');
  const catalogPath = artifactPath(repoRoot, required(flags, 'catalog'));
  const docsPath = artifactPath(repoRoot, required(flags, 'docs'));
  const atlasPath = artifactPath(repoRoot, required(flags, 'atlas'));
  const expectedCatalogPath = artifactPath(repoRoot, required(flags, 'expected-catalog'));
  const expectedDocsPath = artifactPath(repoRoot, required(flags, 'expected-docs'));
  const expectedAtlasPath = artifactPath(repoRoot, required(flags, 'expected-atlas'));
  const [expectedCatalog, expectedDocs, expectedAtlas, actualCatalog, actualDocs, actualAtlas] = await Promise.all([
    readFile(expectedCatalogPath, 'utf8'),
    readFile(expectedDocsPath, 'utf8'),
    readFile(expectedAtlasPath, 'utf8'),
    readFile(catalogPath, 'utf8'),
    readFile(docsPath, 'utf8'),
    readFile(atlasPath, 'utf8'),
  ]);
  const stale = [];
  if (actualCatalog !== expectedCatalog) stale.push(catalogPath);
  if (actualDocs !== expectedDocs) stale.push(docsPath);
  if (actualAtlas !== expectedAtlas) stale.push(atlasPath);
  if (stale.length) fail('CONTRACT_GENERATED_ARTIFACT_STALE', 'generated contract evidence is stale', { stale });
  return { ok:true };
}

async function check(flags) {
  const expectedFlags = ['expected-catalog', 'expected-docs', 'expected-atlas'];
  const providedExpected = expectedFlags.filter((name) => Boolean(flags[name]));
  if (providedExpected.length) {
    if (providedExpected.length !== expectedFlags.length) {
      fail('CONTRACT_CLI_INVALID', '--expected-catalog, --expected-docs, and --expected-atlas must be provided together');
    }
    return checkPrecomputed(flags);
  }

  const { repoRoot, catalog } = await compileFor(flags);
  const catalogPath = artifactPath(repoRoot, required(flags, 'catalog'));
  const docsPath = artifactPath(repoRoot, required(flags, 'docs'));
  const atlasPath = artifactPath(repoRoot, required(flags, 'atlas'));
  const expectedCatalog = canonicalJson(catalog) + '\n';
  const expectedDocs = renderCatalogMarkdown(catalog) + '\n';
  const expectedAtlas = renderAuthorityAtlasMarkdown(catalog) + '\n';
  const [actualCatalog, actualDocs, actualAtlas] = await Promise.all([
    readFile(catalogPath, 'utf8'),
    readFile(docsPath, 'utf8'),
    readFile(atlasPath, 'utf8'),
  ]);
  const stale = [];
  if (actualCatalog !== expectedCatalog) stale.push(catalogPath);
  if (actualDocs !== expectedDocs) stale.push(docsPath);
  if (actualAtlas !== expectedAtlas) stale.push(atlasPath);
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