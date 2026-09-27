import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

import ts from 'typescript';

import type {
  WorkflowFunctionEffectProbe,
  WorkflowFunctionEffectReachability,
  WorkflowReachableProductionEffect,
} from '../src/observation/workflow-transitive-effects.ts';

interface EffectTerminal {
  path: string;
  symbol: string;
  effect: WorkflowReachableProductionEffect;
}

const EFFECT_TERMINALS: readonly EffectTerminal[] = [
  {
    path: 'src/source/source-integration.ts',
    symbol: 'brokerSourceProposal',
    effect: 'git-remote-ref/mutate',
  },
  {
    path: 'src/source/source-integration.ts',
    symbol: 'integrateVerifiedSourceCandidate',
    effect: 'git-remote-ref/mutate',
  },
  {
    path: 'src/providers/github/status-effect.ts',
    symbol: 'performGithubCommitStatusEffect',
    effect: 'github-commit-status/create',
  },
  {
    path: 'src/providers/github/pr-update-branch-effect.ts',
    symbol: 'performGithubPullRequestUpdateBranchEffect',
    effect: 'github-pull-request/update-branch',
  },
];

function normalized(root: string, path: string): string {
  return relative(root, resolve(path)).replaceAll('\\', '/');
}

function declarationName(declaration: ts.Declaration): string | null {
  if (ts.isFunctionDeclaration(declaration)) return declaration.name?.text ?? null;
  if (
    ts.isMethodDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration)
  ) {
    return declaration.name.getText(declaration.getSourceFile());
  }
  if (ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) {
    const parent = declaration.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  return null;
}

function declarationBody(declaration: ts.Declaration): ts.Node | null {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isConstructorDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration)
  ) {
    return declaration.body ?? null;
  }
  return null;
}

function terminalFor(root: string, declaration: ts.Declaration): EffectTerminal | null {
  const name = declarationName(declaration);
  if (!name) return null;
  const path = normalized(root, declaration.getSourceFile().fileName);
  return (
    EFFECT_TERMINALS.find((candidate) => candidate.path === path && candidate.symbol === name) ??
    null
  );
}

function declarationDigest(declaration: ts.Declaration): string {
  const source = declaration.getSourceFile();
  const text = source.text.slice(declaration.getStart(source), declaration.getEnd());
  return createHash('sha256').update(text).digest('hex');
}

function callLabel(root: string, declaration: ts.Declaration): string {
  const path = normalized(root, declaration.getSourceFile().fileName);
  return `${path}#${declarationName(declaration) ?? '<anonymous>'}`;
}

function moduleChain(callChain: readonly string[]): string[] {
  const paths: string[] = [];
  for (const call of callChain) {
    const path = call.split('#', 1)[0]!;
    if (paths.at(-1) !== path) paths.push(path);
  }
  return paths;
}

function functionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function directCalls(rootNode: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== rootNode && functionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(rootNode);
  return calls;
}

function config(root: string): ts.ParsedCommandLine {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('TYPESCRIPT_EFFECT_REACHABILITY_TSCONFIG_MISSING');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      `TYPESCRIPT_EFFECT_REACHABILITY_TSCONFIG_INVALID:${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
    );
  }
  return ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath);
}

export function createTypeScriptFunctionEffectProbe(
  root = process.cwd(),
): WorkflowFunctionEffectProbe {
  const parsed = config(root);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const checker = program.getTypeChecker();

  return (entrypoint: string): WorkflowFunctionEffectReachability[] => {
    const absolute = resolve(root, entrypoint);
    const source = program.getSourceFile(absolute);
    if (!source) return [];

    const results: WorkflowFunctionEffectReachability[] = [];
    const visitedAtDepth = new Map<string, number>();
    const pending: Array<{ declaration: ts.Declaration; call_chain: string[] }> = [];

    const enqueue = (declaration: ts.Declaration, callChain: string[]): void => {
      const body = declarationBody(declaration);
      if (!body) return;
      const label = callLabel(root, declaration);
      const depth = callChain.length;
      const seenDepth = visitedAtDepth.get(label);
      if (seenDepth !== undefined && seenDepth <= depth) return;
      visitedAtDepth.set(label, depth);
      pending.push({ declaration, call_chain: callChain });
    };

    const inspectCall = (call: ts.CallExpression, callChain: string[]): void => {
      const declaration = checker.getResolvedSignature(call)?.getDeclaration();
      if (!declaration) return;
      const path = normalized(root, declaration.getSourceFile().fileName);
      if (path.startsWith('..') || declaration.getSourceFile().isDeclarationFile) return;

      const nextChain = [...callChain, callLabel(root, declaration)];
      const terminal = terminalFor(root, declaration);
      if (terminal) {
        results.push({
          effect: terminal.effect,
          terminal_path: terminal.path,
          terminal_symbol: terminal.symbol,
          import_chain: moduleChain(nextChain),
          call_chain: nextChain,
          terminal_statement_sha256: declarationDigest(declaration),
        });
        return;
      }
      enqueue(declaration, nextChain);
    };

    const rootChain = [`${normalized(root, absolute)}#<module>`];
    for (const call of directCalls(source)) inspectCall(call, rootChain);

    while (pending.length > 0) {
      const current = pending.shift()!;
      const body = declarationBody(current.declaration);
      if (!body) continue;
      for (const call of directCalls(body)) inspectCall(call, current.call_chain);
    }

    const unique = new Map<string, WorkflowFunctionEffectReachability>();
    for (const result of results) {
      const key = [
        result.effect,
        result.terminal_path,
        result.terminal_symbol,
        result.call_chain.join('>'),
      ].join('\0');
      unique.set(key, result);
    }
    return [...unique.values()].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  };
}
