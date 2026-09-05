import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(new URL('../', import.meta.url).pathname);
const RUNNER_NAME = /^run[A-Z][A-Za-z0-9_$]*(?:Tests|Spec)$/;
const HELPER_NAMES = new Set(['run', 'test', 't']);

function parse(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) {
    const text = parsed.parseDiagnostics.map((diagnostic) => diagnostic.messageText).join('; ');
    throw new Error(`${file}: parse failed: ${text}`);
  }
  return parsed;
}

function exported(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function declarationName(declaration) {
  return ts.isIdentifier(declaration.name) ? declaration.name.text : null;
}

function functionLikeHelper(statement) {
  if (ts.isFunctionDeclaration(statement) && statement.name && HELPER_NAMES.has(statement.name.text) && statement.parameters.length >= 2) {
    return statement.name.text;
  }
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return null;
  const declaration = statement.declarationList.declarations[0];
  const name = declarationName(declaration);
  if (!name || !HELPER_NAMES.has(name)) return null;
  if (!declaration.initializer || !(ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return null;
  return declaration.initializer.parameters.length >= 2 ? name : null;
}

function isEmptyArrayDeclaration(statement, collectors) {
  if (!ts.isVariableStatement(statement)) return false;
  return statement.declarationList.declarations.every((declaration) => {
    const name = declarationName(declaration);
    return name && collectors.has(name) && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer) && declaration.initializer.elements.length === 0;
  });
}

function callIdentifier(call) {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

function awaitedCall(node) {
  return ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) ? node.expression : null;
}

function containsOtherSuiteCall(node, currentRunner) {
  let found = false;
  function visit(candidate) {
    if (found) return;
    if (ts.isCallExpression(candidate)) {
      const name = callIdentifier(candidate);
      if (name && name !== currentRunner && RUNNER_NAME.test(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

function applyEdits(source, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = source;
  let priorStart = source.length + 1;
  for (const edit of ordered) {
    if (edit.end > priorStart) throw new Error(`overlapping migration edits at ${edit.start}:${edit.end}`);
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    priorStart = edit.start;
  }
  return result;
}

function relativeModuleSpecifier(file, specifier) {
  if (!/^(?:api|lib|mcp|pages|scripts)\//.test(specifier)) return specifier;
  const absolute = path.join(root, specifier);
  let relative = path.relative(path.dirname(path.join(root, file)), absolute).replaceAll(path.sep, '/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

function rewriteRepoImports(file, source) {
  return source.replace(/(from\s+['"])((?:api|lib|mcp|pages|scripts)\/[^'"]+)(['"])/g, (_match, prefix, specifier, suffix) => `${prefix}${relativeModuleSpecifier(file, specifier)}${suffix}`);
}

function stripLegacyRunnerImports(file, source) {
  const sf = parse(file, source);
  const edits = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const elements = statement.importClause.namedBindings.elements;
    const legacy = elements.filter((element) => RUNNER_NAME.test(element.name.text));
    if (legacy.length === 0) continue;
    if (legacy.length !== elements.length || statement.importClause.name) {
      throw new Error(`${file}: mixed legacy runner import requires explicit migration`);
    }
    edits.push({ start: statement.getFullStart(), end: statement.end, text: '' });
  }
  return applyEdits(source, edits);
}

function humanName(identifier) {
  return identifier.replace(/^test/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() || identifier;
}

function stripCollectorBookkeeping(file, source, collectors) {
  const sf = parse(file, source);
  const edits = [];
  for (const statement of sf.statements) {
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && callIdentifier(statement.expression) === 'test') continue;
    let referencesCollector = false;
    function visit(node) {
      if (referencesCollector) return;
      if (ts.isIdentifier(node) && collectors.has(node.text)) {
        referencesCollector = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(statement);
    if (referencesCollector) edits.push({ start:statement.getFullStart(), end:statement.end, text:'' });
  }
  return applyEdits(source, edits);
}

function directRegistrations(runner, sf) {
  for (const statement of runner.body.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declarationName(declaration) !== 'tests' || !declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) continue;
        if (declaration.initializer.elements.length === 0) continue;
        if (declaration.initializer.elements.every((element) => ts.isIdentifier(element) && /^test[A-Z]/.test(element.text))) {
          return declaration.initializer.elements.map((element) => ({ name:humanName(element.text), fn:element.text }));
        }
      }
    }
    if (ts.isForOfStatement(statement) && ts.isArrayLiteralExpression(statement.expression)) {
      const entries = [];
      for (const element of statement.expression.elements) {
        if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) { entries.length = 0; break; }
        const [name, fn] = element.elements;
        if (!ts.isStringLiteral(name) || !ts.isIdentifier(fn) || !/^test[A-Z]/.test(fn.text)) { entries.length = 0; break; }
        entries.push({ name:name.text, fn:fn.text });
      }
      if (entries.length) return entries;
    }
  }
  return null;
}

function migrateSource(file, source) {
  const sf = parse(file, source);
  const runners = sf.statements.filter((statement) => ts.isFunctionDeclaration(statement) && statement.name && exported(statement) && RUNNER_NAME.test(statement.name.text));
  if (runners.length !== 1) throw new Error(`${file}: expected exactly one exported legacy runner, found ${runners.length}`);
  const runner = runners[0];
  const runnerName = runner.name.text;
  const topLevelHelpers = new Map();
  for (const statement of sf.statements) {
    if (statement === runner) continue;
    const name = functionLikeHelper(statement);
    if (name) topLevelHelpers.set(name, statement);
  }

  const direct = directRegistrations(runner, sf);
  if (direct) {
    const registrations = direct.map(({ name, fn }) => `test(${JSON.stringify(name)}, ${fn});`).join('\n');
    const edits = [{ start:runner.getFullStart(), end:runner.end, text:`\n${registrations}\n` }];
    for (const statement of topLevelHelpers.values()) edits.push({ start:statement.getFullStart(), end:statement.end, text:'' });
    let migrated = stripLegacyRunnerImports(file, applyEdits(source, edits));
    migrated = rewriteRepoImports(file, migrated);
    if (!migrated.includes("from 'node:test'") && !migrated.includes('from "node:test"')) {
      migrated = ["import test from 'node:test';", migrated].join('\n');
    }
    parse(file, migrated);
    return migrated;
  }

  const localHelpers = new Map();
  const collectors = new Set();
  for (const statement of runner.body.statements) {
    const helper = functionLikeHelper(statement);
    if (helper) localHelpers.set(helper, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declarationName(declaration);
        if (name && /^(?:results|r)$/.test(name) && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) collectors.add(name);
      }
    }
  }
  const helperNames = new Set([...topLevelHelpers.keys(), ...localHelpers.keys()]);
  if (helperNames.size === 0) {
    const directNames = new Set();
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && /^test[A-Z]/.test(statement.name.text)) directNames.add(statement.name.text);
    }
    if (directNames.size === 0) throw new Error(`${file}: no legacy helper or direct named tests found`);
  }

  const bodyStart = runner.body.getStart(sf) + 1;
  const bodyEnd = runner.body.end - 1;
  const bodyEdits = [];
  const removeStatement = (statement) => bodyEdits.push({ start: statement.getFullStart() - bodyStart, end: statement.end - bodyStart, text: '' });

  for (const statement of runner.body.statements) {
    if (localHelpers.has(functionLikeHelper(statement))) {
      removeStatement(statement);
      continue;
    }
    if (isEmptyArrayDeclaration(statement, collectors)) {
      removeStatement(statement);
      continue;
    }
    if (ts.isReturnStatement(statement)) {
      removeStatement(statement);
      continue;
    }
    if (containsOtherSuiteCall(statement, runnerName)) {
      removeStatement(statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const text = statement.getText(sf);
      if ([...collectors].some((name) => new RegExp(`\\b${name}\\.(?:filter|every|map|length)\\b`).test(text))) {
        removeStatement(statement);
        continue;
      }
    }
  }

  const removedRanges = bodyEdits.map(({ start, end }) => ({ start: start + bodyStart, end: end + bodyStart }));
  const insideRemoved = (node) => removedRanges.some((range) => node.getStart(sf) >= range.start && node.end <= range.end);

  function visit(node) {
    if (insideRemoved(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'push' && ts.isIdentifier(node.expression.expression) && collectors.has(node.expression.expression.text) && node.arguments.length === 1) {
      const inner = awaitedCall(node.arguments[0]);
      const helper = inner && callIdentifier(inner);
      if (inner && helperNames.has(helper)) {
        const args = inner.arguments.map((argument) => argument.getText(sf)).join(', ');
        bodyEdits.push({ start: node.getStart(sf) - bodyStart, end: node.end - bodyStart, text: `test(${args})` });
        return;
      }
    }
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const name = callIdentifier(call);
      if (name && helperNames.has(name)) {
        const args = call.arguments.map((argument) => argument.getText(sf)).join(', ');
        bodyEdits.push({ start: node.getStart(sf) - bodyStart, end: node.end - bodyStart, text: `test(${args})` });
        return;
      }
      if (name && /^test[A-Z]/.test(name) && call.arguments.length === 0) {
        bodyEdits.push({ start: node.getStart(sf) - bodyStart, end: node.end - bodyStart, text: `test(${JSON.stringify(humanName(name))}, ${name})` });
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(runner.body);

  let promoted = source.slice(bodyStart, bodyEnd);
  promoted = applyEdits(promoted, bodyEdits);
  promoted = stripCollectorBookkeeping(file, promoted, collectors);

  const promotedAst = parse(file, promoted);
  for (const statement of promotedAst.statements) {
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && callIdentifier(statement.expression) === 'test') continue;
    let survivingCollector = null;
    function visitCollector(node) {
      if (survivingCollector) return;
      if (ts.isIdentifier(node) && collectors.has(node.text)) {
        survivingCollector = node.text;
        return;
      }
      ts.forEachChild(node, visitCollector);
    }
    visitCollector(statement);
    if (survivingCollector) throw new Error(`${file}: collector ${survivingCollector} survived migration`);
  }
  for (const helper of helperNames) {
    if (helper !== 'test' && new RegExp(`\\b${helper}\\s*\\(`).test(promoted)) throw new Error(`${file}: helper ${helper} survived migration`);
  }
  if (/\bawait\s+run[A-Z][A-Za-z0-9_$]*(?:Tests|Spec)\s*\(/.test(promoted)) throw new Error(`${file}: nested legacy suite survived migration`);

  const fileEdits = [{ start: runner.getFullStart(), end: runner.end, text: promoted.trim() ? `\n${promoted.trim()}\n` : '' }];
  for (const statement of topLevelHelpers.values()) fileEdits.push({ start: statement.getFullStart(), end: statement.end, text: '' });
  let migrated = stripLegacyRunnerImports(file, applyEdits(source, fileEdits));
  migrated = rewriteRepoImports(file, migrated);
  if (!/from\s+['"]node:test['"]/.test(migrated)) migrated = `import test from 'node:test';\n${migrated}`;

  const reparsed = parse(file, migrated);
  const remainingRunner = reparsed.statements.some((statement) => ts.isFunctionDeclaration(statement) && statement.name && exported(statement) && RUNNER_NAME.test(statement.name.text));
  if (remainingRunner) throw new Error(`${file}: exported legacy runner survived migration`);
  if (/\b(?:results|r)\.push\s*\(\s*await\s+(?:run|test|t)\s*\(/.test(migrated)) throw new Error(`${file}: legacy result aggregation survived migration`);
  return migrated;
}

async function filesUnder(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes:true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

const ordinary = (await filesUnder('lib')).filter((file) => /\.(?:test|spec)\.js$/.test(file)).sort();
const explicitLegacyTests = ['lib/project-agent-session-boundary-regression.js'];
const migrated = [];
const failures = [];
for (const file of [...ordinary, ...explicitLegacyTests]) {
  const source = await readFile(path.join(root, file), 'utf8');
  const target = file === 'lib/github-text-transport.spec.js'
    ? 'lib/github-text-transport.test.js'
    : file === 'lib/project-agent-session-boundary-regression.js'
      ? 'lib/project-agent-session-boundary.test.js'
      : file;
  try {
    const output = migrateSource(target, source);
    if (target !== file) await rename(path.join(root, file), path.join(root, target));
    await writeFile(path.join(root, target), output);
    migrated.push({ from:file, to:target });
  } catch (error) {
    failures.push({ file, target, error:String(error?.message || error) });
  }
}

console.log(JSON.stringify({ schema:'node-test-migration-v1', migrated_count:migrated.length, failure_count:failures.length, migrated, failures }, null, 2));
if (failures.length) process.exitCode = 1;
