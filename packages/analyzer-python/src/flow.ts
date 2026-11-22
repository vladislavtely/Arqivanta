import type { parser } from '@lezer/python';
import type { FlowDefinition, SourceRef } from '@arqivanta/shared';

type Tree = ReturnType<typeof parser.parse>;
type SyntaxNode = Tree['topNode'];
type SourceLines = (node: SyntaxNode) => Omit<SourceRef, 'path'>;
type Binding = { name: string; module?: string };
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const maxDefinitions = 200;
const maxCalls = 500;

export function readPythonFlow(tree: Tree, source: string, path: string, lines: SourceLines) {
  const bindings = new Map<string, Binding | null>();
  const factories = new Map<string, string>();
  const definitions: FlowDefinition[] = [];
  const functions = new Map<number, FlowDefinition>();
  const decorators: { functionNode: SyntaxNode; decorator: SyntaxNode }[] = [];
  const assignments: { name: string; factory: string }[] = [];
  const calls: SyntaxNode[] = [];
  let wildcard = false;
  const text = (node: SyntaxNode) => source.slice(node.from, node.to);
  function bind(local: string, binding: Binding | null) {
    bindings.set(local, bindings.has(local) ? null : binding);
  }
  function readImports(node: SyntaxNode) {
    const part = /^from\s+([.\p{L}\p{N}_]+)\s+import\s+([\s\S]+)$/u.exec(text(node));
    if (part) {
      const [, module, specifiers] = part;
      if (specifiers!.includes('*')) wildcard = true;
      for (const item of specifiers!.replace(/[()]/gu, '').split(',')) {
        const match = /^\s*([\p{L}_][\p{L}\p{N}_]*)(?:\s+as\s+([\p{L}_][\p{L}\p{N}_]*))?\s*$/u.exec(
          item,
        );
        if (!match) continue;
        const [, name, alias] = match;
        const specifier = module!.endsWith('.') ? module + name! : `${module}.${name}`;
        bind(alias ?? name!, node.parent?.type.isTop ? { name: name!, module: specifier } : null);
      }
      return;
    }
    for (const item of text(node)
      .replace(/^import\s+/u, '')
      .split(',')) {
      const match = /([\p{L}_][\p{L}\p{N}_.]*)(?:\s+as\s+([\p{L}_][\p{L}\p{N}_]*))?/u.exec(item);
      if (match) bind(match[2] ?? match[1]!.split('.')[0]!, null);
    }
  }

  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name === 'ImportStatement') readImports(node);
      if (node.name === 'AssignStatement' || node.name === 'UpdateStatement') {
        const first = node.firstChild;
        if (first?.name === 'VariableName') {
          const name = text(first);
          bind(name, { name: '' });
          const init = first.nextSibling?.nextSibling;
          const factory = init?.name === 'CallExpression' ? init.firstChild : null;
          if (node.parent?.type.isTop && factory?.name === 'VariableName')
            assignments.push({ name, factory: text(factory) });
        } else if (first) {
          for (const name of text(first).matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) bind(name[0], null);
        }
      }
      if (
        node.name === 'ParamList' ||
        node.name === 'ForStatement' ||
        node.name === 'WithStatement' ||
        node.name === 'TryStatement' ||
        node.name === 'DeleteStatement'
      ) {
        // These constructs can introduce or replace bindings. Keep ambiguous names unresolved.
        for (
          let child = node.firstChild;
          child && child.name !== 'Body';
          child = child.nextSibling
        ) {
          if (child.name === 'VariableName') bind(text(child), null);
        }
      }
      if (node.name === 'ClassDefinition' || node.name === 'FunctionDefinition') {
        const identifier = node.getChild('VariableName');
        if (!identifier) return;
        const name = text(identifier);
        const wrapper = node.parent?.name === 'DecoratedStatement' ? node.parent : undefined;
        const top = (wrapper ?? node).parent?.type.isTop;
        if (node.name !== 'FunctionDefinition' || !top || definitions.length >= maxDefinitions) {
          bind(name, null);
          return;
        }
        const key = `function:${name}`;
        bind(name, { name: key });
        const definition: FlowDefinition = {
          key,
          label: name,
          kind: 'function',
          exportName: name,
          path,
          ...lines(node),
          calls: [],
        };
        definitions.push(definition);
        functions.set(node.from, definition);
        for (const decorator of wrapper?.getChildren('Decorator') ?? [])
          decorators.push({ functionNode: node, decorator });
      }
      if (node.name === 'CallExpression') calls.push(node);
    },
  });

  let recorded = 0;
  for (const call of calls) {
    if (recorded >= maxCalls) break;
    let owner = call.parent;
    while (
      owner &&
      !['FunctionDefinition', 'LambdaExpression', 'ClassDefinition'].includes(owner.name)
    )
      owner = owner.parent;
    const definition = owner?.name === 'FunctionDefinition' ? functions.get(owner.from) : undefined;
    const expression = call.firstChild;
    if (!definition || !expression) continue;
    const label = text(expression).slice(0, 180);
    const candidate = expression.name === 'VariableName' ? bindings.get(label) : undefined;
    definition.calls.push({
      label,
      ...lines(expression),
      binding: !wildcard && candidate?.name ? candidate : undefined,
    });
    recorded++;
  }

  if (!wildcard) {
    for (const { name, factory } of assignments) {
      const module = bindings.get(factory)?.module;
      if (bindings.get(name) && (module === 'fastapi.FastAPI' || module === 'fastapi.APIRouter'))
        factories.set(name, module);
    }
  }
  const routeLabels = new Set<string>();
  const ambiguous = new Set<string>();
  for (const { functionNode, decorator } of decorators) {
    const match =
      /^@([\p{L}_][\p{L}\p{N}_]*)\.([a-z]+)\s*\(\s*(['"])([^'"\\\r\n]{1,250})\3(?=\s*(?:,|\)))/u.exec(
        text(decorator),
      );
    const next = match && functions.get(functionNode.from);
    if (!match || !next || !factories.has(match[1]!) || !methods.has(match[2]!)) continue;
    const label = `${match[2]!.toUpperCase()} ${match[4]}`;
    if (routeLabels.has(label)) {
      ambiguous.add(label);
      continue;
    }
    routeLabels.add(label);
    if (definitions.length < maxDefinitions)
      definitions.push({
        ...next,
        kind: 'http',
        key: `http:${label}`,
        label,
        exportName: undefined,
        registration: { path, ...lines(decorator) },
      });
  }
  return definitions.filter((definition) =>
    definition.kind === 'http'
      ? !ambiguous.has(definition.label)
      : bindings.get(definition.label)?.name === definition.key,
  );
}
