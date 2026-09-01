import { readFile } from 'node:fs/promises';
import ts from 'typescript';

function fail(message, details = null) {
  const error = new Error(message);
  Object.assign(error, { code:'CONTRACT_SEMVER_POLICY_UNREADABLE', details });
  throw error;
}

function unwrap(node) {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  if (current
      && ts.isCallExpression(current)
      && ts.isPropertyAccessExpression(current.expression)
      && current.expression.expression.getText() === 'Object'
      && current.expression.name.text === 'freeze'
      && current.arguments.length === 1) {
    return unwrap(current.arguments[0]);
  }
  return current;
}

function literalArrayFor(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      const value = unwrap(declaration.initializer);
      if (!value || !ts.isArrayLiteralExpression(value)) fail(`${name} must be a literal string array`);
      const items = [];
      for (const element of value.elements) {
        const literal = unwrap(element);
        if (!literal || !ts.isStringLiteralLike(literal)) fail(`${name} must contain only string literals`);
        items.push(literal.text);
      }
      return items;
    }
  }
  fail(`${name} is missing from SemVer policy source`);
}

export async function readOvercenterSemverKinds(sourcePath) {
  let source;
  try {
    source = await readFile(sourcePath, 'utf8');
  } catch (cause) {
    const error = new Error(`cannot read SemVer policy source ${sourcePath}`, { cause });
    Object.assign(error, { code:'CONTRACT_SEMVER_POLICY_UNREADABLE', source_path:sourcePath });
    throw error;
  }
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sourceFile.parseDiagnostics?.length) fail('SemVer policy source is not parseable', { source_path:sourcePath });
  const publicKinds = literalArrayFor(sourceFile, 'SEMVER_PUBLIC_API_KINDS');
  const internalKinds = literalArrayFor(sourceFile, 'SEMVER_INTERNAL_IMPLEMENTATION_KINDS');
  return new Set([...publicKinds, ...internalKinds]);
}
