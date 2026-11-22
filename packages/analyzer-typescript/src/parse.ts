import path from 'node:path';
import { comparePaths, isJavaScriptOrTypeScript } from '@arqivanta/shared';
import type { Diagnostic, FileRecord, SourceFile } from '@arqivanta/shared';
import ts from 'typescript';
import { readTypeScriptFlow } from './flow.ts';

const recordLimit = 500;
const parseDiagnosticLimit = 20;

function bindingNames(name: ts.BindingName): string[] {
  const pending = [name];
  const names: string[] = [];
  while (pending.length > 0 && names.length < recordLimit) {
    const current = pending.pop();
    if (!current) break;
    if (ts.isIdentifier(current)) {
      names.push(current.text);
      continue;
    }
    for (let index = current.elements.length - 1; index >= 0; index--) {
      const element = current.elements[index];
      if (ts.isBindingElement(element)) pending.push(element.name);
    }
  }
  return names;
}

function isBinding(node: ts.Identifier) {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  );
}

function language(filePath: string) {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (extension === '.json') return 'JSON';
  if (extension === '.md') return 'Markdown';
  if (/^\.[cm]?tsx?$/.test(extension)) return 'TypeScript';
  if (/^\.[cm]?jsx?$/.test(extension)) return 'JavaScript';
  return 'Text';
}

function propertyName(node: ts.PropertyName | undefined) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    ? node.text
    : undefined;
}

function commonJsExport(expression: ts.Expression, shadowed: Set<string>) {
  if (!ts.isPropertyAccessExpression(expression)) return;
  const owner = expression.expression;
  if (ts.isIdentifier(owner)) {
    if (owner.text === 'exports' && !shadowed.has('exports')) return expression.name.text;
    if (owner.text === 'module' && expression.name.text === 'exports' && !shadowed.has('module'))
      return 'default';
  }
  if (
    ts.isPropertyAccessExpression(owner) &&
    ts.isIdentifier(owner.expression) &&
    owner.expression.text === 'module' &&
    owner.name.text === 'exports' &&
    !shadowed.has('module')
  ) {
    return expression.name.text;
  }
}

export function parseFile(
  file: SourceFile,
  report: (diagnostic: Diagnostic, syntaxError?: boolean) => void,
): FileRecord {
  const result: FileRecord = {
    path: file.path,
    language: language(file.path),
    bytes: file.bytes,
    lines: file.source.split(/\r\n|[\n\r\u2028\u2029]/).length,
    imports: [],
    exports: [],
    symbols: [],
  };
  if (!isJavaScriptOrTypeScript(file.path)) return result;

  const source = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
  const parsed = source as ts.SourceFile & {
    parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
  };
  for (const diagnostic of parsed.parseDiagnostics?.slice(0, parseDiagnosticLimit) ?? []) {
    report(
      {
        severity: 'warning',
        path: file.path,
        line: source.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      },
      true,
    );
  }
  if ((parsed.parseDiagnostics?.length ?? 0) > parseDiagnosticLimit) {
    report({
      severity: 'warning',
      path: file.path,
      message: 'Additional syntax diagnostics were omitted.',
    });
  }

  let truncated = false;
  function add<T>(collection: T[], entry: T) {
    if (collection.length < recordLimit) collection.push(entry);
    else truncated = true;
  }

  function reference(node: ts.Node) {
    const start = node.getStart(source);
    const end = Math.max(start, node.getEnd() - 1);
    return {
      startLine: source.getLineAndCharacterOfPosition(start).line + 1,
      endLine: source.getLineAndCharacterOfPosition(end).line + 1,
    };
  }

  function addImport(node: ts.Node, specifier: ts.Node | undefined, kind: string) {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      add(result.imports, { specifier: specifier.text, kind, ...reference(node) });
    }
  }

  function addExport(node: ts.Node, name: string, kind: string) {
    add(result.exports, { name, kind, ...reference(node) });
  }

  function addSymbol(node: ts.Node, name: string, kind: string) {
    add(result.symbols, { name, kind, ...reference(node) });
  }

  const shadowed = new Set<string>();
  const identifiers: ts.Identifier[] = [];
  const calls: (ts.CallExpression | ts.NewExpression)[] = [];
  const writes = new Set<string>();
  const commonJsCalls: ts.CallExpression[] = [];
  const pending: ts.Node[] = [source];
  const children: ts.Node[] = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (ts.isIdentifier(node) && isBinding(node)) {
      identifiers.push(node);
      if (['require', 'module', 'exports'].includes(node.text)) shadowed.add(node.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = node.left;
      if (ts.isIdentifier(left)) writes.add(left.text);
      if (
        (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
        ts.isIdentifier(left.expression)
      )
        writes.add(left.expression.text);
      if (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left))
        for (const name of left.getText(source).matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu))
          writes.add(name[0]);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    )
      writes.add(node.operand.text);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
        addImport(node, node.arguments[0], 'dynamic import');
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        add(commonJsCalls, node);
      }
    }
    children.length = 0;
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  if (!shadowed.has('require')) {
    for (const call of commonJsCalls) addImport(call, call.arguments[0], 'require');
  }

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const kind = statement.importClause?.isTypeOnly
        ? 'type import'
        : statement.importClause
          ? 'import'
          : 'side-effect import';
      addImport(statement, statement.moduleSpecifier, kind);
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      if (ts.isExternalModuleReference(statement.moduleReference)) {
        addImport(statement, statement.moduleReference.expression, 'import equals');
      }
      if (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export)
        addExport(statement, statement.name.text, 'import equals');
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      addImport(
        statement,
        statement.moduleSpecifier,
        statement.isTypeOnly ? 'type re-export' : 're-export',
      );
      const clause = statement.exportClause;
      if (!clause) addExport(statement, '*', statement.isTypeOnly ? 'type re-export' : 're-export');
      else if (ts.isNamespaceExport(clause))
        addExport(clause, clause.name.text, 'namespace re-export');
      else
        for (const item of clause.elements) {
          const kind =
            item.isTypeOnly || statement.isTypeOnly
              ? 'type export'
              : statement.moduleSpecifier
                ? 're-export'
                : 'named export';
          addExport(item, item.name.text, kind);
        }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      addExport(statement, statement.isExportEquals ? 'export=' : 'default', 'export assignment');
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const name = commonJsExport(statement.expression.left, shadowed);
      if (name) addExport(statement, name, 'CommonJS export');
      continue;
    }

    let entries: { node: ts.Node; name: string; kind: string }[] = [];
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        const kind =
          initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
            ? 'function'
            : 'variable';
        for (const name of bindingNames(declaration.name)) {
          if (entries.length < recordLimit) entries.push({ node: declaration, name, kind });
          else truncated = true;
        }
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      const kind = ts.isFunctionDeclaration(statement)
        ? 'function'
        : ts.isClassDeclaration(statement)
          ? 'class'
          : ts.isInterfaceDeclaration(statement)
            ? 'interface'
            : ts.isTypeAliasDeclaration(statement)
              ? 'type'
              : ts.isEnumDeclaration(statement)
                ? 'enum'
                : 'namespace';
      entries = [{ node: statement, name: statement.name?.text ?? 'default', kind }];
      if (ts.isClassDeclaration(statement) && statement.name) {
        for (const member of statement.members) {
          const name = propertyName(member.name);
          if (name)
            addSymbol(
              member,
              `${statement.name.text}.${name}`,
              ts.isMethodDeclaration(member) ? 'method' : 'member',
            );
        }
      }
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    for (const entry of entries) {
      addSymbol(entry.node, entry.name, entry.kind);
      if (exported) {
        addExport(entry.node, isDefault ? 'default' : entry.name, entry.kind);
      }
    }
  }

  result.imports.sort(
    (a, b) =>
      a.startLine - b.startLine || a.endLine - b.endLine || comparePaths(a.specifier, b.specifier),
  );
  result.exports.sort((a, b) => a.startLine - b.startLine || comparePaths(a.name, b.name));
  result.symbols.sort((a, b) => a.startLine - b.startLine || comparePaths(a.name, b.name));
  if (!parsed.parseDiagnostics?.length) {
    const flow = readTypeScriptFlow(source, file.path, reference, { identifiers, calls, writes });
    if (flow.length) result.flow = flow;
  }
  if (truncated)
    report({
      severity: 'warning',
      path: file.path,
      message:
        'Some relationships or symbols were omitted after reaching the per-file record limit.',
    });
  return result;
}
