import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { fingerprintStructure, sourceIdentity } from '../canonical.mjs';

const printer = ts.createPrinter({ removeComments:true, newLine:ts.NewLineKind.LineFeed });

function repoPath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/');
}

async function collect(root, extension) {
  const entries = await readdir(root, { withFileTypes:true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      files.push(...await collect(path, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.includes('.test.')) {
      files.push(path);
    }
  }
  return files;
}

function exported(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function unwrap(initializer) {
  let current = initializer;
  while (current && (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  if (current && ts.isCallExpression(current)
      && ts.isPropertyAccessExpression(current.expression)
      && current.expression.expression.getText() === 'Object'
      && current.expression.name.text === 'freeze'
      && current.arguments.length === 1) {
    return unwrap(current.arguments[0]);
  }
  return current;
}

function contractLikeName(name) {
  return /(?:SCHEMA|CONTRACT|POLICY|KINDS|STATES|DISPOSITIONS|CLASSES|SURFACES|FIELDS|VALUES)$/.test(name);
}

function structuredInitializer(name, initializer) {
  const value = unwrap(initializer);
  if (!value) return false;
  if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return true;
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isClassExpression(value)) return false;
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) return false;
  return contractLikeName(name);
}

function normalizedSyntax(node, sourceFile) {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).trim();
}

function candidate(kind, path, anchor, node, sourceFile) {
  const structure = { syntax:normalizedSyntax(node, sourceFile) };
  return {
    source_identity:sourceIdentity(kind, path, anchor),
    source_kind:kind,
    source_location:{ path, anchor },
    symbol_or_boundary:anchor,
    structural_fingerprint:fingerprintStructure(structure),
    structure,
    observed_relationships:[],
  };
}

function declarationCandidates(sourceFile, kind, path) {
  const candidates = [];
  for (const statement of sourceFile.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && exported(statement) && statement.name) {
      candidates.push(candidate(kind, path, statement.name.text, statement, sourceFile));
      continue;
    }
    if (!ts.isVariableStatement(statement) || !exported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !structuredInitializer(declaration.name.text, declaration.initializer)) continue;
      candidates.push(candidate(kind, path, declaration.name.text, declaration, sourceFile));
    }
  }
  return candidates;
}

async function parseFile(repoRoot, path, kind) {
  const source = await readFile(path, 'utf8');
  const scriptKind = kind === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  if (sourceFile.parseDiagnostics?.length) {
    const error = new Error(`cannot parse contract-bearing source ${repoPath(repoRoot, path)}`);
    Object.assign(error, { code:'CONTRACT_SOURCE_PARSE_FAILED', diagnostics:sourceFile.parseDiagnostics.map((item) => item.messageText) });
    throw error;
  }
  return declarationCandidates(sourceFile, kind, repoPath(repoRoot, path));
}

async function runtimeProjectionMap(repoRoot, runtimeTsconfig, javascriptRoot) {
  const configPath = join(repoRoot, runtimeTsconfig);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const rootDir = String(config?.compilerOptions?.rootDir || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const includes = Array.isArray(config?.include) ? config.include.filter((item) => typeof item === 'string' && item.endsWith('.ts')) : [];
  const mapping = new Map();
  for (const source of includes) {
    const normalized = source.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!rootDir || !normalized.startsWith(`${rootDir}/`)) continue;
    const relativeSource = normalized.slice(rootDir.length + 1).replace(/\.ts$/, '.js');
    mapping.set(normalized, `${javascriptRoot.replace(/\/$/, '')}/${relativeSource}`);
  }
  return mapping;
}

export function createSourceDiscoverer(options = {}) {
  const typescriptRoot = options.typescriptRoot || 'src';
  const javascriptRoot = options.javascriptRoot || 'lib';
  const runtimeTsconfig = options.runtimeTsconfig || 'tsconfig.semantic.runtime.json';
  return {
    name:'overcenter-source',
    async discover({ repoRoot }) {
      const [typescriptFiles, javascriptFiles, projections] = await Promise.all([
        collect(join(repoRoot, typescriptRoot), '.ts'),
        collect(join(repoRoot, javascriptRoot), '.js'),
        runtimeProjectionMap(repoRoot, runtimeTsconfig, javascriptRoot),
      ]);
      const candidates = [];
      for (const path of typescriptFiles) candidates.push(...await parseFile(repoRoot, path, 'typescript'));
      for (const path of javascriptFiles) candidates.push(...await parseFile(repoRoot, path, 'javascript'));

      const byIdentity = new Map(candidates.map((item) => [item.source_identity, item]));
      for (const [typescriptPath, javascriptPath] of projections) {
        const sourceCandidates = candidates.filter((item) => item.source_kind === 'typescript' && item.source_location.path === typescriptPath);
        for (const sourceCandidate of sourceCandidates) {
          const mirrorIdentity = sourceIdentity('javascript', javascriptPath, sourceCandidate.symbol_or_boundary);
          const mirror = byIdentity.get(mirrorIdentity);
          if (!mirror) continue;
          mirror.observed_relationships = [{
            kind:'generated-projection-of',
            target:sourceCandidate.source_identity,
          }];
        }
      }

      candidates.sort((a, b) => a.source_identity.localeCompare(b.source_identity));
      return {
        complete:true,
        candidates,
        diagnostics:[{
          code:'SOURCE_DISCOVERY_COMPLETE',
          typescript_files:typescriptFiles.length,
          javascript_files:javascriptFiles.length,
        }],
      };
    },
  };
}
