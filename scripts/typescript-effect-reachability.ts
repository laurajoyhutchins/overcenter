import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

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
  SyntaxKind,
} from 'typescript/unstable/ast';

import { runtimeLocalImportSpecifiers } from '../src/observation/workflow-transitive-effects.ts';
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

function resolveLocalModule(root: string, fromPath: string, specifier: string): string | null {
  const base = resolve(root, dirname(fromPath), specifier);
  const candidates = [
    base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : '',
    base.endsWith('.ts') ? base : `${base}.ts`,
    resolve(base, 'index.ts'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? normalized(root, found) : null;
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

type CallableBinding = Node | null;
type CallableBindings = Map<string, CallableBinding>;

function parameterKey(root: string, parameter: Node): string {
  const source = parameter.getSourceFile();
  return [normalized(root, source.fileName), parameter.getStart(source), parameter.getEnd()].join(
    ':',
  );
}

function parameterName(parameter: Node): string | null {
  const source = parameter.getSourceFile();
  const match = parameter
    .getText(source)
    .match(/^(?:\.\.\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\?|:|=|$)/);
  return match?.[1] ?? null;
}

function scopedBindingKey(scope: string, name: string): string {
  return `scope:${scope}:${name}`;
}

function lexicalBinding(
  bindings: CallableBindings,
  callChain: readonly string[],
  name: string,
): CallableBinding | undefined {
  for (let index = callChain.length - 1; index >= 0; index -= 1) {
    const binding = bindings.get(scopedBindingKey(callChain[index]!, name));
    if (binding !== undefined || bindings.has(scopedBindingKey(callChain[index]!, name))) {
      return binding;
    }
  }
  return undefined;
}

function callableParameters(declaration: Node): readonly Node[] {
  if (
    isFunctionDeclaration(declaration) ||
    isMethodDeclaration(declaration) ||
    isConstructorDeclaration(declaration) ||
    isGetAccessorDeclaration(declaration) ||
    isSetAccessorDeclaration(declaration) ||
    isFunctionExpression(declaration) ||
    isArrowFunction(declaration)
  ) {
    return declaration.parameters;
  }
  return [];
}

function bindingsForCall(
  root: string,
  declaration: Node,
  call: CallExpression,
  inherited: CallableBindings,
): CallableBindings {
  const bindings = new Map(inherited);
  const scope = callLabel(root, declaration);
  for (const [index, parameter] of callableParameters(declaration).entries()) {
    const binding = call.arguments[index] ?? null;
    bindings.set(parameterKey(root, parameter), binding);
    const name = parameterName(parameter);
    if (name) bindings.set(scopedBindingKey(scope, name), binding);
  }
  return bindings;
}

function bindingStateKey(root: string, bindings: CallableBindings): string {
  return [...bindings.entries()]
    .map(([key, binding]) => {
      if (binding === null) return `${key}=<absent>`;
      const source = binding.getSourceFile();
      return [
        key,
        normalized(root, source.fileName),
        binding.getStart(source),
        binding.getEnd(),
      ].join('=');
    })
    .sort()
    .join('|');
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

function candidateEffectsFromModule(
  root: string,
  project: Project,
  startPath: string,
): WorkflowReachableProductionEffect[] {
  const effects = new Set<WorkflowReachableProductionEffect>();
  const seen = new Set<string>();
  const pending = [startPath];

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    for (const terminal of EFFECT_TERMINALS) {
      if (terminal.path === current) effects.add(terminal.effect);
    }

    const source = project.program.getSourceFile(resolve(root, current));
    if (!source) continue;
    for (const specifier of runtimeLocalImportSpecifiers(source.text)) {
      const target = resolveLocalModule(root, current, specifier);
      if (target && !seen.has(target)) pending.push(target);
    }
  }

  return [...effects].sort();
}

export function createTypeScriptFunctionEffectProbe(
  root = process.cwd(),
): WorkflowFunctionEffectProbe {
  const api = new API({ cwd: root });
  const { snapshot, project } = projectForRoot(api, root);
  const checker = project.checker;
  const candidateEffectsCache = new Map<string, WorkflowReachableProductionEffect[]>();
  const candidateEffects = (path: string): WorkflowReachableProductionEffect[] => {
    const cached = candidateEffectsCache.get(path);
    if (cached) return cached;
    const computed = candidateEffectsFromModule(root, project, path);
    candidateEffectsCache.set(path, computed);
    return computed;
  };

  const probe: WorkflowFunctionEffectProbe = (entrypoint: string) => {
    const absolute = resolve(root, entrypoint);
    const source = project.program.getSourceFile(absolute);
    if (!source) return { effects: [], unresolved_calls: [] };

    const results: WorkflowFunctionEffectReachability[] = [];
    const unresolvedCalls: WorkflowUnresolvedFunctionCall[] = [];
    const visitedAtDepth = new Map<string, number>();
    const pending: Array<{
      declaration: Node;
      call_chain: string[];
      bindings: CallableBindings;
    }> = [];

    const enqueue = (declaration: Node, callChain: string[], bindings: CallableBindings): void => {
      const body = declarationBody(declaration);
      if (!body) return;
      const label = callLabel(root, declaration);
      const stateKey = `${label}\0${bindingStateKey(root, bindings)}`;
      const depth = callChain.length;
      const seenDepth = visitedAtDepth.get(stateKey);
      if (seenDepth !== undefined && seenDepth <= depth) return;
      visitedAtDepth.set(stateKey, depth);
      pending.push({ declaration, call_chain: callChain, bindings });
    };

    const inspectCall = (
      call: CallExpression,
      callChain: string[],
      bindings: CallableBindings,
    ): void => {
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
        const symbol = declarationName(declaration) ?? call.expression.getText(callSource);
        const positionalBinding =
          declaration.kind === SyntaxKind.Parameter
            ? bindings.get(parameterKey(root, declaration))
            : undefined;
        const binding =
          positionalBinding !== undefined
            ? positionalBinding
            : lexicalBinding(bindings, callChain, symbol);
        const bindingKnown =
          positionalBinding !== undefined ||
          (declaration.kind === SyntaxKind.Parameter &&
            bindings.has(parameterKey(root, declaration))) ||
          callChain.some((scope) => bindings.has(scopedBindingKey(scope, symbol)));

        if (bindingKnown) {
          if (binding === null) return;
          if (binding !== undefined && functionLike(binding) && declarationBody(binding)) {
            enqueue(binding, [...callChain, callLabel(root, binding)], bindings);
            return;
          }
          if (binding !== undefined) {
            const position = callSource.getLineAndCharacterOfPosition(call.getStart(callSource));
            const bindingPath = normalized(root, binding.getSourceFile().fileName);
            unresolvedCalls.push({
              call_site_path: normalized(root, callSource.fileName),
              call_site_line: position.line + 1,
              call_expression_sha256: createHash('sha256')
                .update(call.getText(callSource))
                .digest('hex'),
              declaration_path: path,
              declaration_symbol: symbol,
              call_chain: [...callChain, `${path}#${symbol}`],
              candidate_effects: candidateEffects(bindingPath),
            });
            return;
          }
        }


        const position = callSource.getLineAndCharacterOfPosition(call.getStart(callSource));
        const symbol = declarationName(declaration) ?? call.expression.getText(callSource);
        unresolvedCalls.push({
          call_site_path: normalized(root, callSource.fileName),
          call_site_line: position.line + 1,
          call_expression_sha256: createHash('sha256')
            .update(call.getText(callSource))
            .digest('hex'),
          declaration_path: path,
          declaration_symbol: symbol,
          call_chain: [...callChain, `${path}#${symbol}`],
          candidate_effects: candidateEffects(path),
        });
        return;
      }
      enqueue(declaration, nextChain, bindingsForCall(root, declaration, call, bindings));
    };

    const rootChain = [`${normalized(root, absolute)}#<module>`];
    const rootBindings: CallableBindings = new Map();
    for (const call of directCalls(source)) inspectCall(call, rootChain, rootBindings);

    while (pending.length > 0) {
      const current = pending.shift()!;
      const body = declarationBody(current.declaration);
      if (!body) continue;
      for (const call of directCalls(body)) {
        inspectCall(call, current.call_chain, current.bindings);
      }
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
        unresolved.candidate_effects.join(','),
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
