import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { fingerprintStructure } from '../canonical.mjs';

const printer = ts.createPrinter({ removeComments:true, newLine:ts.NewLineKind.LineFeed });

function syntax(node, sourceFile) {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).trim();
}

function stringLiteral(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function importedSymbols(sourceFile) {
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) imports.set(clause.name.text, { module, symbol:'default' });
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, { module, symbol:element.propertyName?.text || element.name.text });
      }
    }
  }
  return imports;
}

function localInitializers(sourceFile) {
  const values = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) values.set(declaration.name.text, declaration.initializer);
    }
  }
  return values;
}

export function createSemanticDescriptorDiscoverer(options = {}) {
  const sourcePath = options.source || 'src/semantic/semantic-command-descriptors.ts';
  return {
    name:'overcenter-semantic-descriptors',
    async discover({ repoRoot }) {
      const source = await readFile(join(repoRoot, sourcePath), 'utf8');
      const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      if (sourceFile.parseDiagnostics?.length) {
        const error = new Error(`cannot parse ${sourcePath}`);
        Object.assign(error, { code:'CONTRACT_DESCRIPTOR_PARSE_FAILED' });
        throw error;
      }
      const imports = importedSymbols(sourceFile);
      const locals = localInitializers(sourceFile);
      const candidates = [];

      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'descriptor' && node.arguments.length >= 5) {
          const command = stringLiteral(node.arguments[0]);
          const surface = stringLiteral(node.arguments[4]);
          const schemaExpression = node.arguments[3];
          if (command && surface && schemaExpression) {
            const resolvedSchema = ts.isIdentifier(schemaExpression) && locals.has(schemaExpression.text)
              ? locals.get(schemaExpression.text)
              : schemaExpression;
            const structure = {
              command,
              mcp_name:stringLiteral(node.arguments[1]) || syntax(node.arguments[1], sourceFile),
              surface,
              input_schema:{ syntax:syntax(resolvedSchema, sourceFile) },
              exposure:{ syntax:node.arguments[5] ? syntax(node.arguments[5], sourceFile) : 'default' },
            };
            const relationships = [];
            if (ts.isIdentifier(schemaExpression) && imports.has(schemaExpression.text)) {
              const reference = imports.get(schemaExpression.text);
              relationships.push({ kind:'source-reference', module:reference.module, symbol:reference.symbol });
            }
            candidates.push({
              source_identity:`semantic-command:${command}#input`,
              source_kind:'semantic-command',
              source_location:{ path:sourcePath, anchor:command },
              symbol_or_boundary:`${command}.input`,
              structural_fingerprint:fingerprintStructure(structure),
              structure,
              observed_relationships:relationships,
            });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);
      candidates.sort((a, b) => a.source_identity.localeCompare(b.source_identity));
      return { complete:true, candidates, diagnostics:[{ code:'SEMANTIC_DESCRIPTOR_DISCOVERY_COMPLETE', count:candidates.length }] };
    },
  };
}
