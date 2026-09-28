#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { API, SymbolFlags, type Symbol as TypeScriptSymbol } from 'typescript/unstable/sync';

import { repositoryRelativePath } from '../src/analysis/typescript-runtime.ts';
import {
  SyntaxKind,
  isClassDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isVariableStatement,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast';

import {
  analyzeCodeWitnesses,
  type CodeReferenceObservation,
  type ExplicitCodeWitness,
  type ProductionSymbolKind,
  type ProductionSymbolObservation,
} from '../src/repository/code-witness.ts';

interface Candidate {
  key: string;
  path: string;
  symbol: string;
  declaration: Node;
  name_node: Node;
  observation: ProductionSymbolObservation;
}

interface TcbEntry {
  path?: string;
  symbol?: string;
  whole_file?: boolean;
}

interface TcbProperty {
  entries?: TcbEntry[];
  trusted_symbol_boundaries?: string[];
  runtime_dispatch_bindings?: Array<{
    implementation?: {
      path?: string;
      symbol?: string;
    };
  }>;
}

interface TcbPolicy {
  properties?: TcbProperty[];
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(repositoryRelativePath(path));
  }
  return found;
}

function productionSource(path: string): boolean {
  return (
    path.startsWith('src/') &&
    path.endsWith('.ts') &&
    !path.endsWith('.d.ts') &&
    !path.includes('/generated/') &&
    !path.endsWith('.generated.ts')
  );
}

function hasModifier(node: Node, kind: SyntaxKind): boolean {
  const modifiers = (node as Node & { modifiers?: readonly Node[] }).modifiers ?? [];
  return modifiers.some((modifier) => modifier.kind === kind);
}

function exported(node: Node): boolean {
  return (
    hasModifier(node, SyntaxKind.ExportKeyword) || hasModifier(node, SyntaxKind.DefaultKeyword)
  );
}

function simpleParameters(node: Node): string[] | null {
  const parameters = (node as Node & { parameters?: readonly Node[] }).parameters;
  if (!parameters) return null;
  const names: string[] = [];
  for (const parameter of parameters) {
    const typed = parameter as Node & {
      name?: Node;
      dotDotDotToken?: Node;
      initializer?: Node;
    };
    if (!typed.name || !isIdentifier(typed.name) || typed.dotDotDotToken || typed.initializer) {
      return null;
    }
    names.push(typed.name.text);
  }
  return names;
}

function returnedExpression(node: Node): Node | null {
  const body = (node as Node & { body?: Node }).body;
  if (!body) return null;
  if (body.kind !== SyntaxKind.Block) return body;
  const statements = (body as Node & { statements?: readonly Node[] }).statements ?? [];
  if (statements.length !== 1 || statements[0]?.kind !== SyntaxKind.ReturnStatement) return null;
  return (statements[0] as Node & { expression?: Node }).expression ?? null;
}

function transparentCallTarget(node: Node, source: SourceFile): string | undefined {
  if (
    hasModifier(node, SyntaxKind.AsyncKeyword) ||
    (node as Node & { asteriskToken?: Node }).asteriskToken
  ) {
    return undefined;
  }
  const parameters = simpleParameters(node);
  const expression = returnedExpression(node);
  if (!parameters || !expression || expression.kind !== SyntaxKind.CallExpression) {
    return undefined;
  }
  const call = expression as Node & {
    expression: Node;
    arguments: readonly Node[];
  };
  if (call.arguments.length !== parameters.length) return undefined;
  for (let index = 0; index < parameters.length; index += 1) {
    const argument = call.arguments[index];
    if (!argument || !isIdentifier(argument) || argument.text !== parameters[index]) {
      return undefined;
    }
  }
  return call.expression.getText(source);
}

function architectureWitnessPaths(): Set<string> {
  const path = '.overcenter/architecture-intent.json';
  if (!existsSync(path)) return new Set();
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    claims?: Array<Record<string, unknown>>;
  };
  const witnessed = new Set<string>();
  for (const claim of document.claims ?? []) {
    if (claim.kind !== 'authority-role') continue;
    if (typeof claim.authority === 'string') witnessed.add(claim.authority);
    for (const key of ['projections', 'verifiers'] as const) {
      const values = claim[key];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value === 'string') witnessed.add(value);
      }
    }
  }
  return witnessed;
}

function tcbPolicy(): TcbPolicy {
  if (!existsSync('tcb-policy.json')) return {};
  return JSON.parse(readFileSync('tcb-policy.json', 'utf8')) as TcbPolicy;
}

function explicitWitnesses(
  path: string,
  symbol: string,
  architecturePaths: Set<string>,
  policy: TcbPolicy,
): ExplicitCodeWitness[] {
  const witnesses: ExplicitCodeWitness[] = [];
  if (architecturePaths.has(path)) {
    witnesses.push({ kind: 'architecture-intent', detail: path });
  }

  const selector = path + '#' + symbol;
  for (const property of policy.properties ?? []) {
    for (const entry of property.entries ?? []) {
      if (entry.path !== path) continue;
      if (entry.whole_file === true) {
        witnesses.push({ kind: 'tcb-whole-file', detail: path });
      } else if (entry.symbol === symbol) {
        witnesses.push({ kind: 'tcb-symbol', detail: selector });
      }
    }
    if ((property.trusted_symbol_boundaries ?? []).includes(selector)) {
      witnesses.push({ kind: 'tcb-symbol', detail: selector });
    }
    for (const binding of property.runtime_dispatch_bindings ?? []) {
      if (binding.implementation?.path === path && binding.implementation.symbol === symbol) {
        witnesses.push({ kind: 'tcb-symbol', detail: selector });
      }
    }
  }

  const unique = new Map(
    witnesses.map((witness) => [witness.kind + ':' + witness.detail, witness] as const),
  );
  return [...unique.values()].sort((left, right) =>
    (left.kind + ':' + left.detail).localeCompare(right.kind + ':' + right.detail),
  );
}

function inTypeSpace(node: Node): boolean {
  let current = node.parent;
  while (current && current.kind !== SyntaxKind.SourceFile) {
    if (
      (current.kind >= SyntaxKind.FirstTypeNode && current.kind <= SyntaxKind.LastTypeNode) ||
      current.kind === SyntaxKind.InterfaceDeclaration ||
      current.kind === SyntaxKind.TypeAliasDeclaration
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function inImportSyntax(node: Node): boolean {
  let current = node.parent;
  while (current && current.kind !== SyntaxKind.SourceFile) {
    if (
      current.kind === SyntaxKind.ImportDeclaration ||
      current.kind === SyntaxKind.ImportClause ||
      current.kind === SyntaxKind.ImportSpecifier ||
      current.kind === SyntaxKind.NamespaceImport
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function sourceRevision(): string {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const expected = process.env.SOURCE_SHA;
  if (expected && expected !== head) {
    throw new Error('CODE_WITNESS_SOURCE_REVISION_MISMATCH:' + expected + ':' + head);
  }
  return head;
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('CODE_WITNESS_ARGUMENT_VALUE_REQUIRED:' + name);
  }
  return value;
}

function summaryMarkdown(report: ReturnType<typeof analyzeCodeWitnesses>): string {
  const lines = [
    '## Production code witnesses',
    '',
    '- observed symbols: ' + report.summary.observed_symbols,
    '- witnessed roots: ' + report.summary.root_symbols,
    '- reachable symbols: ' + report.summary.reachable_symbols,
    '- unwitnessed private symbols: ' + report.summary.unwitnessed_symbols,
    '- transparent single-caller wrappers: ' + report.summary.simplification_candidates,
  ];
  if (report.findings.length === 0) return lines.join('\n') + '\n';

  lines.push('', '| Finding | Symbol | Evidence |', '| --- | --- | --- |');
  for (const finding of report.findings.slice(0, 25)) {
    const symbol = finding.path + ':' + finding.start_line + '#' + finding.symbol;
    const evidence = finding.evidence.join('; ').replaceAll('|', '\\|');
    lines.push('| ' + finding.code + ' | ' + symbol + ' | ' + evidence + ' |');
  }
  if (report.findings.length > 25) {
    lines.push('', 'First 25 findings shown; full JSON report contains the remainder.');
  }
  return lines.join('\n') + '\n';
}

const revision = sourceRevision();
const sourcePaths = filesUnder('src').filter(productionSource).sort();
const architecturePaths = architectureWitnessPaths();
const policy = tcbPolicy();
const api = new API({ cwd: process.cwd() });
const snapshot = api.updateSnapshot({ openFiles: sourcePaths.map((path) => resolve(path)) });
const candidates = new Map<string, Candidate>();
const candidatesByPath = new Map<string, Candidate[]>();
const declarationNames = new Set<Node>();

function checkerFor(node: Node) {
  const project = snapshot.getDefaultProjectForFile(node.getSourceFile().fileName);
  if (!project) {
    throw new Error('CODE_WITNESS_PROJECT_UNAVAILABLE:' + node.getSourceFile().fileName);
  }
  return project.checker;
}

function resolvedValueSymbol(node: Node): TypeScriptSymbol | null {
  const checker = checkerFor(node);
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  const resolved = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (checker.isUnknownSymbol(resolved)) return null;
  return resolved.flags & SymbolFlags.Value ? resolved : null;
}

function targetKey(node: Node): string | null {
  const symbol = resolvedValueSymbol(node);
  if (!symbol) return null;
  const declaration = symbol.valueDeclaration ?? symbol.declarations[0];
  if (!declaration) return null;
  const path = repositoryRelativePath(declaration.path);
  return path + '#' + symbol.name;
}

function addCandidate(
  path: string,
  source: SourceFile,
  declaration: Node,
  nameNode: Node,
  kind: ProductionSymbolKind,
  isExported: boolean,
  transparentTarget?: string,
): void {
  if (!isIdentifier(nameNode)) return;
  const symbol = nameNode.text;
  const key = path + '#' + symbol;
  if (candidates.has(key)) throw new Error('CODE_WITNESS_CANDIDATE_DUPLICATE:' + key);
  const startLine = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
  const observation: ProductionSymbolObservation = {
    source_revision: revision,
    path,
    symbol,
    start_line: startLine,
    kind,
    exported: isExported,
    top_level_reference: false,
    explicit_witnesses: explicitWitnesses(path, symbol, architecturePaths, policy),
    ...(transparentTarget ? { transparent_call_target: transparentTarget } : {}),
  };
  const candidate: Candidate = {
    key,
    path,
    symbol,
    declaration,
    name_node: nameNode,
    observation,
  };
  candidates.set(key, candidate);
  const inFile = candidatesByPath.get(path) ?? [];
  inFile.push(candidate);
  candidatesByPath.set(path, inFile);
  declarationNames.add(nameNode);
}

try {
  for (const path of sourcePaths) {
    const absolute = resolve(path);
    const project = snapshot.getDefaultProjectForFile(absolute);
    const source = project?.program.getSourceFile(absolute);
    if (!source) throw new Error('CODE_WITNESS_SOURCE_UNAVAILABLE:' + path);

    for (const statement of source.statements) {
      if (isFunctionDeclaration(statement) || isClassDeclaration(statement)) {
        const name = (statement as Node & { name?: Node }).name;
        if (!name || !isIdentifier(name)) continue;
        if (
          isFunctionDeclaration(statement) &&
          !(statement as Node & { body?: Node }).body
        ) {
          declarationNames.add(name);
          continue;
        }
        addCandidate(
          path,
          source,
          statement,
          name,
          isFunctionDeclaration(statement) ? 'function' : 'class',
          exported(statement),
          isFunctionDeclaration(statement) ? transparentCallTarget(statement, source) : undefined,
        );
        continue;
      }

      if (!isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (
          declaration.initializer.kind !== SyntaxKind.ArrowFunction &&
          declaration.initializer.kind !== SyntaxKind.FunctionExpression
        ) {
          continue;
        }
        addCandidate(
          path,
          source,
          declaration,
          declaration.name,
          'callable-variable',
          exported(statement),
          transparentCallTarget(declaration.initializer, source),
        );
      }
    }
  }

  const edgeKeys = new Set<string>();
  const references: CodeReferenceObservation[] = [];

  for (const path of sourcePaths) {
    const absolute = resolve(path);
    const project = snapshot.getDefaultProjectForFile(absolute);
    const source = project?.program.getSourceFile(absolute);
    if (!source) throw new Error('CODE_WITNESS_SOURCE_UNAVAILABLE:' + path);
    const inFile = candidatesByPath.get(path) ?? [];

    const visit = (node: Node): void => {
      if (
        isIdentifier(node) &&
        !declarationNames.has(node) &&
        !inTypeSpace(node) &&
        !inImportSyntax(node)
      ) {
        const to = targetKey(node);
        const target = to ? candidates.get(to) : undefined;
        if (target) {
          const position = node.getStart(source);
          const owner = inFile.find(
            (candidate) =>
              position >= candidate.declaration.getStart(source) &&
              position < candidate.declaration.getEnd(),
          );
          if (!owner) {
            target.observation.top_level_reference = true;
          } else if (owner.key !== target.key) {
            const edgeKey = owner.key + '\0' + target.key;
            if (!edgeKeys.has(edgeKey)) {
              edgeKeys.add(edgeKey);
              references.push({
                source_revision: revision,
                from: { path: owner.path, symbol: owner.symbol },
                to: { path: target.path, symbol: target.symbol },
              });
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }

  const report = analyzeCodeWitnesses({
    source_revision: revision,
    symbols: [...candidates.values()].map((candidate) => candidate.observation),
    references,
  });

  const output = argValue('--output');
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  else console.log(JSON.stringify(report, null, 2));

  const summary = argValue('--summary');
  if (summary) appendFileSync(summary, summaryMarkdown(report));

  if (process.argv.includes('--fail-on-findings') && report.findings.length > 0) {
    process.exitCode = 1;
  }
} finally {
  snapshot.dispose();
  api.close();
}
