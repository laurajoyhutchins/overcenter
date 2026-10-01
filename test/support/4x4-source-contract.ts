import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { API } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isSetAccessorDeclaration,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast';

export const FOUR_BY_FOUR_NOUNS = ['Object', 'Event', 'Proposition', 'Coordinate'] as const;
export const FOUR_BY_FOUR_VERBS = ['permits', 'asserts', 'supports', 'requires'] as const;

interface RoleExpectation {
  symbol: string;
  calls: string[];
  literals: string[];
}

export interface SourceContract {
  schema: 'overcenter-4x4-source-contract/v1';
  nouns: string[];
  verbs: string[];
  source: { path: string; blob_sha: string };
  roles: Record<'admission' | 'release' | 'settlement', RoleExpectation>;
}

interface RoleFacts {
  symbol: string;
  calls: string[];
  literals: string[];
}

export interface ExtractedSourceContract {
  roles: Record<'admission' | 'release' | 'settlement', RoleFacts>;
}

const ROLE_NAMES = ['admission', 'release', 'settlement'] as const;
const CONTRACT_PATH = 'docs/migrations/4x4-strangler/formal/source-contract.json';

function functionLike(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  );
}

function stringLiteral(node: Node, source: SourceFile): string | null {
  if (node.kind !== SyntaxKind.StringLiteral) return null;
  const text = node.getText(source);
  if (text.length < 2) return null;
  return text.slice(1, -1);
}

function methodFacts(source: SourceFile, method: Node): RoleFacts {
  if (!isMethodDeclaration(method) || !method.body) {
    throw new Error('FOUR_BY_FOUR_SOURCE_METHOD_BODY_MISSING');
  }
  const calls = new Set<string>();
  const literals = new Set<string>();
  const visit = (node: Node): void => {
    if (node !== method.body && functionLike(node)) {
      throw new Error('FOUR_BY_FOUR_SOURCE_UNSUPPORTED_NESTED_EXECUTABLE');
    }
    if (isCallExpression(node)) calls.add(node.expression.getText(source));
    const literal = stringLiteral(node, source);
    if (literal !== null) literals.add(literal);
    node.forEachChild((child) => {
      visit(child);
    });
  };
  visit(method.body);
  return {
    symbol: method.name.getText(source),
    calls: [...calls].sort(),
    literals: [...literals].sort(),
  };
}

function extractFromSource(source: SourceFile): ExtractedSourceContract {
  const kernels = source.statements.filter(
    (node) => isClassDeclaration(node) && node.name?.text === 'KernelCore',
  );
  if (kernels.length !== 1) throw new Error('FOUR_BY_FOUR_SOURCE_KERNEL_SHAPE_UNKNOWN');
  const kernel = kernels[0]!;
  const methods = kernel.members.filter(isMethodDeclaration);
  const byName = new Map(methods.map((method) => [method.name.getText(source), method] as const));
  const expectedSymbols = {
    admission: 'beginEffect',
    release: 'releaseEffectReservation',
    settlement: '#settleWithoutObservation',
  } as const;
  return {
    roles: Object.fromEntries(
      ROLE_NAMES.map((role) => {
        const symbol = expectedSymbols[role];
        const method = byName.get(symbol);
        if (!method) throw new Error(`FOUR_BY_FOUR_SOURCE_METHOD_MISSING:${symbol}`);
        return [role, methodFacts(source, method)];
      }),
    ) as ExtractedSourceContract['roles'],
  };
}

export function extractFourByFourSourceContract(
  sourcePath: string,
  root = process.cwd(),
): ExtractedSourceContract {
  const absolute = resolve(root, sourcePath);
  const configPath = resolve(root, 'tsconfig.json');
  const api = new API({ cwd: root });
  const snapshot = api.updateSnapshot({ openProjects: [configPath], openFiles: [absolute] });
  try {
    const project =
      snapshot.getDefaultProjectForFile(absolute) ??
      snapshot.getProject(configPath) ??
      snapshot.getProjects()[0];
    const source = project?.program.getSourceFile(absolute);
    if (!source) throw new Error('FOUR_BY_FOUR_SOURCE_UNAVAILABLE');
    return extractFromSource(source);
  } finally {
    snapshot.dispose();
    api.close();
  }
}

export function assertExtractedFourByFourContract(
  extracted: ExtractedSourceContract,
  expected: SourceContract,
): void {
  if (JSON.stringify(expected.nouns) !== JSON.stringify(FOUR_BY_FOUR_NOUNS)) {
    throw new Error('FOUR_BY_FOUR_NOUN_VOCABULARY_DRIFT');
  }
  if (JSON.stringify(expected.verbs) !== JSON.stringify(FOUR_BY_FOUR_VERBS)) {
    throw new Error('FOUR_BY_FOUR_VERB_VOCABULARY_DRIFT');
  }
  for (const role of ROLE_NAMES) {
    const actual = extracted.roles[role];
    const wanted = expected.roles[role];
    if (actual.symbol !== wanted.symbol) {
      throw new Error(`FOUR_BY_FOUR_SOURCE_SYMBOL_DRIFT:${role}`);
    }
    for (const call of wanted.calls) {
      if (!actual.calls.includes(call)) {
        throw new Error(`FOUR_BY_FOUR_SOURCE_CALL_MISSING:${role}:${call}`);
      }
    }
    for (const literal of wanted.literals) {
      if (!actual.literals.includes(literal)) {
        throw new Error(`FOUR_BY_FOUR_SOURCE_LITERAL_MISSING:${role}:${literal}`);
      }
    }
  }
}

export function loadFourByFourSourceContract(root = process.cwd()): SourceContract {
  return JSON.parse(readFileSync(resolve(root, CONTRACT_PATH), 'utf8')) as SourceContract;
}

export function verifyFourByFourSourceContract(root = process.cwd()): void {
  const contract = loadFourByFourSourceContract(root);
  if (contract.schema !== 'overcenter-4x4-source-contract/v1') {
    throw new Error('FOUR_BY_FOUR_SOURCE_CONTRACT_SCHEMA_INVALID');
  }
  const blob = execFileSync('git', ['-C', root, 'rev-parse', `HEAD:${contract.source.path}`], {
    encoding: 'utf8',
  }).trim();
  if (blob !== contract.source.blob_sha) {
    throw new Error('FOUR_BY_FOUR_SOURCE_IDENTITY_DRIFT');
  }
  assertExtractedFourByFourContract(
    extractFourByFourSourceContract(contract.source.path, root),
    contract,
  );
}
