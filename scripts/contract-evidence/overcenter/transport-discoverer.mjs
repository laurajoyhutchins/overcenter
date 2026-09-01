import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { fingerprintStructure, sourceIdentity } from '../canonical.mjs';

const printer = ts.createPrinter({ removeComments:true, newLine:ts.NewLineKind.LineFeed });

function syntax(node, sourceFile) {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).trim();
}

function repoPath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/');
}

async function collect(root) {
  const entries = await readdir(root, { withFileTypes:true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.includes('.test.')) files.push(path);
  }
  return files;
}

function importsFor(sourceFile) {
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) imports.set(element.name.text, { module, symbol:element.propertyName?.text || element.name.text });
    }
    if (statement.importClause?.name) imports.set(statement.importClause.name.text, { module, symbol:'default' });
  }
  return imports;
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function defaultObject(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && ts.isObjectLiteralExpression(statement.expression)) return statement.expression;
  }
  return null;
}

function objectProperty(object, name) {
  return object?.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === name) || null;
}

function exportedVariable(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer || null;
    }
  }
  return null;
}

function literalText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function literalArray(node) {
  return node && ts.isArrayLiteralExpression(node)
    ? node.elements.map(literalText).filter((value) => value !== null).sort()
    : [];
}

function requestPath(node) {
  const parts = [];
  let current = node;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current) || current.text !== 'req' || parts.length < 2) return null;
  if (!['body','query','params'].includes(parts[0])) return null;
  return parts.join('.');
}

function rootedAtRes(expression) {
  let current = expression;
  while (current) {
    if (ts.isIdentifier(current)) return current.text === 'res';
    if (ts.isPropertyAccessExpression(current)) current = current.expression;
    else if (ts.isCallExpression(current)) current = current.expression;
    else return false;
  }
  return false;
}

function responseShape(argument) {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return { opaque:true };
  const keys = argument.properties
    .map((property) => propertyName(property.name))
    .filter(Boolean)
    .sort();
  return { keys };
}

async function mcpCandidates(repoRoot, root) {
  if (!root) return [];
  const candidates = [];
  for (const file of await collect(join(repoRoot, root))) {
    const path = repoPath(repoRoot, file);
    const source = await readFile(file, 'utf8');
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const object = defaultObject(sourceFile);
    const input = objectProperty(object, 'inputSchema');
    if (!input) continue;
    const imports = importsFor(sourceFile);
    const expression = input.initializer;
    const structure = { input_schema:{ syntax:syntax(expression, sourceFile) } };
    const relationships = [];
    if (ts.isIdentifier(expression) && imports.has(expression.text)) {
      const reference = imports.get(expression.text);
      relationships.push({ kind:'source-reference', module:reference.module, symbol:reference.symbol });
    }
    candidates.push({
      source_identity:sourceIdentity('mcp', path, 'inputSchema'),
      source_kind:'mcp',
      source_location:{ path, anchor:'inputSchema' },
      symbol_or_boundary:'inputSchema',
      structural_fingerprint:fingerprintStructure(structure),
      structure,
      observed_relationships:relationships,
    });
  }
  return candidates;
}

async function httpCandidates(repoRoot, root) {
  if (!root) return [];
  const candidates = [];
  for (const file of await collect(join(repoRoot, root))) {
    const path = repoPath(repoRoot, file);
    const source = await readFile(file, 'utf8');
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const access = literalText(exportedVariable(sourceFile, 'access'));
    const methods = literalArray(exportedVariable(sourceFile, 'methods'));
    const requestPaths = new Set();
    const responseShapes = new Map();
    function visit(node) {
      if (ts.isPropertyAccessExpression(node)) {
        const path = requestPath(node);
        if (path) requestPaths.add(path);
      }
      if (ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'json'
          && rootedAtRes(node.expression.expression)) {
        const shape = responseShape(node.arguments[0]);
        responseShapes.set(JSON.stringify(shape), shape);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    const structure = {
      path,
      access:access || null,
      methods,
      request_paths:[...requestPaths].sort(),
      response_shapes:[...responseShapes.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
    candidates.push({
      source_identity:sourceIdentity('http', path, 'request-response'),
      source_kind:'http',
      source_location:{ path, anchor:'request-response' },
      symbol_or_boundary:'request-response',
      structural_fingerprint:fingerprintStructure(structure),
      structure,
      observed_relationships:[],
    });
  }
  return candidates;
}

export function createTransportDiscoverer(options = {}) {
  const mcpRoot = options.mcpRoot === undefined ? 'mcp' : options.mcpRoot;
  const apiRoot = options.apiRoot === undefined ? 'api' : options.apiRoot;
  return {
    name:'overcenter-transport',
    async discover({ repoRoot }) {
      const candidates = [
        ...await mcpCandidates(repoRoot, mcpRoot),
        ...await httpCandidates(repoRoot, apiRoot),
      ].sort((a, b) => a.source_identity.localeCompare(b.source_identity));
      return { complete:true, candidates, diagnostics:[{ code:'TRANSPORT_DISCOVERY_COMPLETE', count:candidates.length }] };
    },
  };
}
