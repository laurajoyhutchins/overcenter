import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

import { API, type Project } from 'typescript/unstable/sync';
import {
  type CallExpression,
  type Node,
  isArrowFunction,
  isCallExpression,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isVariableDeclaration,
} from 'typescript/unstable/ast';

import type {
  WorkflowFunctionEffectProbe,
  WorkflowFunctionEffectReachability,
  WorkflowReachableProductionEffect,
  WorkflowUnresolvedFunctionCall,
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

function declarationName(declaration: Node): string | null {
  if (isFunctionDeclaration(declaration)) return declaration.name?.text ?? null;
  if (
    isMethodDeclaration(declaration) ||
    isGetAccessorDeclaration(declaration) ||
    isSetAccessorDeclaration(declaration)
  ) {
    return declaration.name.getText(declaration.getSourceFile());
  }
  if (isFunctionExpression(declaration) || isArrowFunction(declaration)) {
    const parent = declaration.parent;
    if (isVariableDeclaration(parent) && isIdentifier(parent.name)) return parent.name.text;
    if (isPropertyAssignment(parent) && isIdentifier(parent.name)) return parent.name.text;
  }
  return null;
}

function declarationBody(declaration: Node): Node | null {
  if (
    isFunctionDeclaration(declaration) ||
    isMethodDeclaration(declaration) ||
    isConstructorDeclaration(declaration) ||
    isGetAccessorDeclaration(declaration) ||
    isSetAccessorDeclaration(declaration) ||
    isFunctionExpression(declaration) ||
    isArrowFunction(declaration)
  ) {
    return declaration.body ?? null;
  }
  return null;
}

function terminalFor(root: string, declaration: Node): EffectTerminal | null {
  const name = declarationName(declaration);
  if (!name) return null;
  const path = normalized(root, declaration.getSourceFile().fileName);
  return (
    EFFECT_TERMINALS.find((candidate) => candidate.path === path && candidate.symbol === name) ??
    null
  );
}

function declarationDigest(declaration: Node): string {
  return createHash('sha256')
    .update(declaration.getText(declaration.getSourceFile()))
    .digest('hex');
}

function callLabel(root: string, declaration: Node): string {
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

function functionLike(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node)
  );
}

function directCalls(rootNode: Node): CallExpression[] {
  const calls: CallExpression[] = [];
  const visit = (node: Node): void => {
    if (node !== rootNode && functionLike(node)) return;
    if (isCallExpression(node)) calls.push(node);
    node.forEachChild((child) => {
      visit(child);
    });
  };
  visit(rootNode);
  return calls;
}

function projectForRoot(
  api: API,
  root: string,
): {
  snapshot: ReturnType<API['updateSnapshot']>;
  project: Project;
} {
  const configPath = resolve(root, 'tsconfig.json');
  const snapshot = api.updateSnapshot({ openProjects: [configPath] });
  const project = snapshot.getProject(configPath) ?? snapshot.getProjects()[0];
  if (!project) {
    snapshot.dispose();
    throw new Error('TYPESCRIPT_EFFECT_REACHABILITY_PROJECT_MISSING');
  }
  return { snapshot, project };
}

export function createTypeScriptFunctionEffectProbe(
  root = process.cwd(),
): WorkflowFunctionEffectProbe {
  const api = new API({ cwd: root });
  const { snapshot, project } = projectForRoot(api, root);
  const checker = project.checker;

  const probe: WorkflowFunctionEffectProbe = (entrypoint: string) => {
    const absolute = resolve(root, entrypoint);
    const source = project.program.getSourceFile(absolute);
    if (!source) return { effects: [], unresolved_calls: [] };

    const results: WorkflowFunctionEffectReachability[] = [];
    const unresolvedCalls: WorkflowUnresolvedFunctionCall[] = [];
    const visitedAtDepth = new Map<string, number>();
    const pending: Array<{ declaration: Node; call_chain: string[] }> = [];

    const enqueue = (declaration: Node, callChain: string[]): void => {
      const body = declarationBody(declaration);
      if (!body) return;
      const label = callLabel(root, declaration);
      const depth = callChain.length;
      const seenDepth = visitedAtDepth.get(label);
      if (seenDepth !== undefined && seenDepth <= depth) return;
      visitedAtDepth.set(label, depth);
      pending.push({ declaration, call_chain: callChain });
    };

    const inspectCall = (call: CallExpression, callChain: string[]): void => {
      const declaration = checker.getResolvedSignature(call)?.declaration?.resolve(project);
      if (!declaration) return;
      const sourceFile = declaration.getSourceFile();
      const path = normalized(root, sourceFile.fileName);
      if (path.startsWith('..') || sourceFile.isDeclarationFile) return;

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

      const body = declarationBody(declaration);
      if (!body) {
        const callSource = call.getSourceFile();
        const position = callSource.getLineAndCharacterOfPosition(call.getStart(callSource));
        unresolvedCalls.push({
          call_site_path: normalized(root, callSource.fileName),
          call_site_line: position.line + 1,
          call_expression_sha256: createHash('sha256')
            .update(call.getText(callSource))
            .digest('hex'),
          declaration_path: path,
          declaration_symbol: declarationName(declaration) ?? '<callable>',
          call_chain: nextChain,
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
    const uniqueUnresolved = new Map<string, WorkflowUnresolvedFunctionCall>();
    for (const unresolved of unresolvedCalls) {
      const key = [
        unresolved.call_site_path,
        unresolved.call_site_line,
        unresolved.call_expression_sha256,
        unresolved.declaration_path,
        unresolved.declaration_symbol,
        unresolved.call_chain.join('>'),
      ].join('\0');
      uniqueUnresolved.set(key, unresolved);
    }
    return {
      effects: [...unique.values()].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
      unresolved_calls: [...uniqueUnresolved.values()].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    };
  };

  probe.dispose = () => {
    snapshot.dispose();
    api.close();
  };
  return probe;
}
