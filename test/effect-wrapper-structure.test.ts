import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { API } from 'typescript/unstable/sync';
import {
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableStatement,
  type CallExpression,
  type MethodDeclaration,
  type Node,
  type SourceFile,
  type Statement,
} from 'typescript/unstable/ast';

function callName(call: CallExpression): string | null {
  if (isIdentifier(call.expression)) return call.expression.text;
  if (isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

function containsCall(node: Node, name: string): boolean {
  let found = false;
  const visit = (candidate: Node): void => {
    if (isCallExpression(candidate) && callName(candidate) === name) found = true;
    if (!found) candidate.forEachChild(visit);
  };
  visit(node);
  return found;
}

function methodNamed(source: SourceFile, name: string): MethodDeclaration | null {
  let found: MethodDeclaration | null = null;
  const visit = (node: Node): void => {
    if (
      isMethodDeclaration(node) &&
      ((isIdentifier(node.name) && node.name.text === name) ||
        (isStringLiteral(node.name) && node.name.text === name))
    ) {
      found = node;
      return;
    }
    if (!found) node.forEachChild(visit);
  };
  visit(source);
  return found;
}

function isDirectCallStatement(statement: Statement, name: string): boolean {
  if (
    isExpressionStatement(statement) &&
    isCallExpression(statement.expression) &&
    callName(statement.expression) === name
  ) {
    return true;
  }
  if (!isVariableStatement(statement)) return false;
  return statement.declarationList.declarations.some(
    (declaration) =>
      !!declaration.initializer &&
      isCallExpression(declaration.initializer) &&
      callName(declaration.initializer) === name,
  );
}

function wrapperMethodReservesBeforeEffect(
  source: SourceFile,
  name: 'performEffect' | 'performEffectSync',
): boolean {
  const method = methodNamed(source, name);
  if (!method?.body) return false;

  const statements = [...method.body.statements];
  const permitIndex = statements.findIndex((statement) =>
    isDirectCallStatement(statement, 'effectAuthorityPermit'),
  );
  const reservationIndex = statements.findIndex((statement) =>
    isDirectCallStatement(statement, 'beginEffect'),
  );
  const effectIndex = statements.findIndex((statement) => containsCall(statement, 'effect'));
  return permitIndex >= 0 && reservationIndex > permitIndex && effectIndex > reservationIndex;
}

function wrappersAreSound(sourceText: string): boolean {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-effect-wrapper-'));
  const path = join(root, 'engine.ts');
  writeFileSync(path, sourceText);
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [path] });
    try {
      const project = snapshot.getDefaultProjectForFile(path);
      const source = project?.program.getSourceFile(path);
      if (!source || !methodNamed(source, 'beginEffect')?.body) return false;
      return (
        wrapperMethodReservesBeforeEffect(source, 'performEffect') &&
        wrapperMethodReservesBeforeEffect(source, 'performEffectSync')
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const soundEngine = `
class KernelCore {
  beginEffect(permit:any) {
    return 'reservation';
  }
  async performEffect(authority:any,effect:any) {
    const permit=effectAuthorityPermit(authority);
    const reservationCommit=this.beginEffect(permit);
    const attempt={reservation_commit:reservationCommit};
    return await effect(attempt);
  }
  performEffectSync(authority:any,effect:any) {
    const permit=effectAuthorityPermit(authority);
    const reservationCommit=this.beginEffect(permit);
    const attempt={reservation_commit:reservationCommit};
    return effect(attempt);
  }
}`;

test('production effect wrappers reserve before invoking callbacks', () => {
  assert.equal(wrappersAreSound(readFileSync('src/authority/engine.ts', 'utf8')), true);
});

test('structural wrapper proof rejects callback execution before async reservation', () => {
  const mutant = soundEngine.replace(
    'const reservationCommit=this.beginEffect(permit);',
    'const result=await effect();\n    const reservationCommit=this.beginEffect(permit);',
  );
  assert.equal(wrappersAreSound(mutant), false);
});

test('structural wrapper proof rejects callback execution before sync reservation', () => {
  const mutant = soundEngine.replace(
    'const reservationCommit=this.beginEffect(permit);\n    const attempt={reservation_commit:reservationCommit};\n    return effect(attempt);',
    'const result=effect();\n    const reservationCommit=this.beginEffect(permit);\n    return result;',
  );
  assert.equal(wrappersAreSound(mutant), false);
});

test('structural wrapper proof rejects conditional reservation', () => {
  const mutant = soundEngine.replace(
    'const reservationCommit=this.beginEffect(permit);',
    'if (permit) this.beginEffect(permit);\n    const reservationCommit="conditional";',
  );
  assert.equal(wrappersAreSound(mutant), false);
});

test('structural wrapper proof rejects callback before authority extraction', () => {
  const mutant = soundEngine.replace(
    'const permit=effectAuthorityPermit(authority);\n    const reservationCommit=this.beginEffect(permit);',
    'const result=await effect();\n    const permit=effectAuthorityPermit(authority);\n    const reservationCommit=this.beginEffect(permit);',
  );
  assert.equal(wrappersAreSound(mutant), false);
});
