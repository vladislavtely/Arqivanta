import ts from 'typescript';
import type { FlowDefinition, SourceRef } from '@arqivanta/shared';

const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const maxDefinitions = 200;
const maxCalls = 500;

type Binding = { node: ts.Identifier; module?: string; imported?: string };

export function readTypeScriptFlow(
  source: ts.SourceFile,
  path: string,
  lines: (node: ts.Node) => Omit<SourceRef, 'path'>,
  nodes: {
    identifiers: ts.Identifier[];
    calls: (ts.CallExpression | ts.NewExpression)[];
    writes: Set<string>;
  },
): FlowDefinition[] {
  if (!nodes.calls.length && !nodes.identifiers.length) return [];
  const bindings = new Map<string, Binding | null>();
  const functions = new Map<ts.Node, FlowDefinition>();
  const definitions: FlowDefinition[] = [];
  const routes: { node: ts.CallExpression; name: string; handler: ts.Expression }[] = [];

  for (const node of nodes.identifiers) {
    if (bindings.has(node.text) || nodes.writes.has(node.text)) {
      bindings.set(node.text, null);
      continue;
    }
    const owner = node.parent;
    const clause = ts.isImportClause(owner)
      ? owner
      : ts.isImportSpecifier(owner)
        ? owner.parent.parent
        : undefined;
    if (clause && ts.isImportDeclaration(clause.parent)) {
      const specifier = clause.parent.moduleSpecifier;
      if (
        ts.isStringLiteralLike(specifier) &&
        !clause.isTypeOnly &&
        !(ts.isImportSpecifier(owner) && owner.isTypeOnly)
      ) {
        bindings.set(node.text, {
          node,
          module: specifier.text,
          imported: ts.isImportSpecifier(owner) ? (owner.propertyName ?? node).text : 'default',
        });
        continue;
      }
    }
    bindings.set(node.text, { node });
  }

  function addFunction(
    node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
    name: string,
    modifiers: ts.Node,
  ) {
    if (!node.body || definitions.length >= maxDefinitions) return;
    const flags = ts.canHaveModifiers(modifiers) ? ts.getModifiers(modifiers) : undefined;
    const exported = flags?.some((token) => token.kind === ts.SyntaxKind.ExportKeyword);
    const defaultExport = flags?.some((token) => token.kind === ts.SyntaxKind.DefaultKeyword);
    const definition: FlowDefinition = {
      path,
      ...lines(node),
      key: `function:${name}`,
      label: name,
      kind: 'function',
      ...(exported ? { exportName: defaultExport ? 'default' : name } : {}),
      calls: [],
    };
    definitions.push(definition);
    functions.set(node, definition);
  }

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name && bindings.get(statement.name.text)?.node === statement.name)
        addFunction(statement, statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const { name, initializer } = declaration;
      if (
        ts.isIdentifier(name) &&
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        bindings.get(name.text)?.node === name
      ) {
        addFunction(initializer, name.text, statement);
      }
    }
  }

  const byFunction = new Set(definitions.map(({ label }) => label));

  function declarationScope(declaration: ts.VariableDeclaration) {
    for (
      let ancestor: ts.Node | undefined = declaration.parent;
      ancestor;
      ancestor = ancestor.parent
    ) {
      if (ts.isBlock(ancestor) || ts.isSourceFile(ancestor)) return ancestor;
      if (
        ts.isForStatement(ancestor) ||
        ts.isForInStatement(ancestor) ||
        ts.isForOfStatement(ancestor)
      )
        return ancestor;
    }
  }

  function isFastifyInstance(receiver: ts.Identifier, call: ts.CallExpression) {
    const declaration = bindings.get(receiver.text)?.node.parent;
    if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
    if (
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return false;
    const init = declaration.initializer;
    if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return false;
    const factory = bindings.get(init.expression.text);
    if (factory?.module !== 'fastify' || !['default', 'fastify'].includes(factory.imported ?? ''))
      return false;
    const scope = declarationScope(declaration);
    for (let ancestor: ts.Node | undefined = call.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor === scope) return true;
    }
    return false;
  }

  for (const call of nodes.calls) {
    if (!ts.isCallExpression(call)) continue;
    const { expression, arguments: args } = call;
    if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression))
      continue;
    const method = expression.name.text;
    const url = args[0];
    const handler = args[args.length - 1];
    if (
      !httpMethods.has(method) ||
      args.length < 2 ||
      !url ||
      !handler ||
      !ts.isStringLiteralLike(url) ||
      url.text.length > 250 ||
      !isFastifyInstance(expression.expression, call)
    )
      continue;
    if (ts.isIdentifier(handler) || ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
      routes.push({ node: call, name: `${method.toUpperCase()} ${url.text}`, handler });
  }

  const routeCounts = new Map<string, number>();
  for (const { name } of routes) routeCounts.set(name, (routeCounts.get(name) ?? 0) + 1);
  for (const { node, name, handler } of routes) {
    if (definitions.length >= maxDefinitions || routeCounts.get(name) !== 1) continue;
    const location = lines(node.expression);
    const registration = {
      path,
      startLine: location.startLine,
      endLine: lines(node.arguments[0]!).endLine,
    };
    const definition: FlowDefinition = {
      path,
      ...lines(handler),
      key: `http:${name}`,
      label: name,
      kind: 'http',
      registration,
      calls: [],
    };
    definitions.push(definition);
    if (ts.isIdentifier(handler)) {
      definition.calls.push({
        label: handler.text,
        ...lines(handler),
        binding: callBinding(handler),
      });
    } else functions.set(handler, definition);
  }

  function callBinding(identifier: ts.Identifier) {
    const binding = bindings.get(identifier.text);
    if (binding?.module && binding.imported)
      return { name: binding.imported, module: binding.module };
    if (binding && byFunction.has(identifier.text)) return { name: `function:${identifier.text}` };
  }

  let calls = 0;
  for (const call of nodes.calls) {
    if (calls >= maxCalls) break;
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) continue;
    let ancestor: ts.Node | undefined = call.parent;
    while (ancestor && !ts.isFunctionLike(ancestor)) ancestor = ancestor.parent;
    const owner = ancestor && functions.get(ancestor);
    if (!owner) continue;
    const expression = call.expression;
    const construct = ts.isNewExpression(call);
    const label = `${construct ? 'new ' : ''}${expression.getText(source)}`.slice(0, 180);
    owner.calls.push({
      label,
      ...lines(expression),
      binding: !construct && ts.isIdentifier(expression) ? callBinding(expression) : undefined,
    });
    calls++;
  }
  return definitions;
}
