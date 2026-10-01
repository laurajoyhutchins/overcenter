import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

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

function functionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function methodFacts(source: ts.SourceFile, method: ts.MethodDeclaration): RoleFacts {
  if (!method.body) throw new Error('FOUR_BY_FOUR_SOURCE_METHOD_BODY_MISSING');
  const calls = new Set<string>();
  const literals = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== method.body && functionLike(node)) {
      throw new Error('FOUR_BY_FOUR_SOURCE_UNSUPPORTED_NESTED_EXECUTABLE');
    }
    if (ts.isCallExpression(node)) calls.add(node.expression.getText(source));
    if (ts.isStringLiteral(node)) literals.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(method.body);
  return {
    symbol: method.name.getText(source),
    calls: [...calls].sort(),
    literals: [...literals].sort(),
  };
}

export function extractFourByFourSourceContract(sourceText: string): ExtractedSourceContract {
  const source = ts.createSourceFile(
    'src/authority/engine.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const kernels = source.statements.filter(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'KernelCore',
  );
  if (kernels.length !== 1) throw new Error('FOUR_BY_FOUR_SOURCE_KERNEL_SHAPE_UNKNOWN');
  const methods = kernels[0]!.members.filter(ts.isMethodDeclaration);
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
  const sourceText = readFileSync(resolve(root, contract.source.path), 'utf8');
  assertExtractedFourByFourContract(extractFourByFourSourceContract(sourceText), contract);
}
