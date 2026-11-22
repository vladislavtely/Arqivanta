import { parser } from '@lezer/python';
import type { Diagnostic, FileRecord, SourceFile, SourceRef } from '@arqivanta/shared';
import { readPythonFlow } from './flow.ts';

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];
const recordLimit = 500;
const diagnosticLimit = 20;

function importNames(
  statement: SyntaxNode,
  source: string,
  add: (name: string, kind: string) => void,
) {
  let child = statement.firstChild;
  if (!child) return;
  const from = child.name === 'from';
  let base = '';
  if (from) {
    for (child = child.nextSibling; child && child.name !== 'import'; child = child.nextSibling) {
      if (child.name === 'VariableName' || child.name === '.' || child.name === 'Ellipsis') {
        base += source.slice(child.from, child.to);
      }
    }
  }
  if (!child || (from && !base)) return;

  let name = '';
  let alias = false;
  function emit() {
    if (name && !from) add(name, 'import');
    else if (name === '*') add(base, 'from import');
    else if (name) add(`${base}${base.endsWith('.') ? '' : '.'}${name}`, 'from member import');
    name = '';
    alias = false;
  }

  for (child = child.nextSibling; child; child = child.nextSibling) {
    if (child.name === ',') emit();
    else if (child.name === 'as') alias = true;
    else if (!alias && (child.name === 'VariableName' || child.name === '.' || child.name === '*'))
      name += source.slice(child.from, child.to);
  }
  emit();
}

export function parseFile(
  file: SourceFile,
  report: (diagnostic: Diagnostic, syntaxError?: boolean) => void,
): FileRecord {
  const lineStarts = [0];
  for (const match of file.source.matchAll(/\r\n|[\n\r]/g)) {
    lineStarts.push(match.index + match[0].length);
  }
  function lineAt(offset: number) {
    let start = 0;
    let end = lineStarts.length;
    while (start + 1 < end) {
      const middle = Math.floor((start + end) / 2);
      if (lineStarts[middle] <= offset) start = middle;
      else end = middle;
    }
    return start + 1;
  }
  function lines(node: SyntaxNode) {
    return { startLine: lineAt(node.from), endLine: lineAt(Math.max(node.from, node.to - 1)) };
  }

  const result: FileRecord = {
    path: file.path,
    language: 'Python',
    bytes: file.bytes,
    lines: lineStarts.length,
    imports: [],
    exports: [],
    symbols: [],
  };
  let errors = 0;
  let truncated = false;
  function add<T>(records: T[], record: T) {
    if (records.length < recordLimit) records.push(record);
    else truncated = true;
  }
  const tree = parser.parse(file.source);
  tree.iterate({
    enter(node) {
      if (node.type.isError) {
        if (errors++ < diagnosticLimit)
          report(
            {
              severity: 'warning',
              path: file.path,
              line: lineAt(node.from),
              message: 'Python syntax error.',
            },
            true,
          );
        return;
      }
      if (node.name === 'ImportStatement') {
        const location = lines(node.node);
        importNames(node.node, file.source, (specifier, kind) => {
          add(result.imports, { specifier, kind, ...location });
        });
      }
      if (node.name === 'FunctionDefinition' || node.name === 'ClassDefinition') {
        const definition = node.node;
        const statement =
          definition.parent?.name === 'DecoratedStatement' ? definition.parent : definition;
        if (statement.parent?.type.isTop) {
          const identifier = definition.getChild('VariableName');
          if (identifier) {
            add(result.symbols, {
              name: file.source.slice(identifier.from, identifier.to),
              kind: node.name === 'FunctionDefinition' ? 'function' : 'class',
              ...lines(statement),
            });
          }
        }
      }
    },
  });
  if (truncated || errors > diagnosticLimit) {
    report({
      severity: 'warning',
      path: file.path,
      message: 'Python analysis omitted records after reaching the per-file limit.',
    });
  }
  if (!errors) {
    const flow = readPythonFlow(tree, file.source, file.path, lines);
    if (flow.length) result.flow = flow;
  }
  return result;
}

export function createModuleResolver(files: SourceFile[]) {
  const paths = new Set(files.map((file) => file.path));
  const srcIsPackage = paths.has('src/__init__.py') || paths.has('src/__init__.pyi');
  function packageFile(path: string) {
    return [`${path}/__init__.py`, `${path}/__init__.pyi`].find((candidate) =>
      paths.has(candidate),
    );
  }
  function moduleFile(path: string) {
    return [`${path}.py`, `${path}.pyi`].find((candidate) => paths.has(candidate));
  }
  function resolveFrom(root: string, segments: string[]) {
    let prefix = root;
    for (const part of segments.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (moduleFile(prefix) && !packageFile(prefix)) return;
    }
    const name = [root, ...segments].filter(Boolean).join('/');
    return name ? (packageFile(name) ?? moduleFile(name)) : undefined;
  }

  return (filePath: string, specifier: string, kind: string) => {
    const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
    const parts = specifier.slice(dots).split('.').filter(Boolean);
    const sourceLayout = !srcIsPackage && filePath.startsWith('src/');
    if (dots) {
      const directory = filePath.split('/').slice(0, -1);
      const packageDepth = directory.length - Number(sourceLayout);
      if (dots > packageDepth) return;
      const root = directory.slice(0, directory.length - dots + 1).join('/');
      const local = (segments: string[]) =>
        segments.length ? resolveFrom(root, segments) : packageFile(root);
      return (
        local(parts) ?? (kind === 'from member import' ? local(parts.slice(0, -1)) : undefined)
      );
    }

    const roots = sourceLayout ? ['src', ''] : [''];
    const targets = new Set(
      roots
        .map((root) => {
          return (
            resolveFrom(root, parts) ??
            (kind === 'from member import' && parts.length > 1
              ? resolveFrom(root, parts.slice(0, -1))
              : undefined)
          );
        })
        .filter((target) => target !== undefined),
    );
    return targets.size === 1 ? targets.values().next().value : undefined;
  };
}

export function findEntryPoints(files: SourceFile[]): SourceRef[] {
  return files
    .filter((file) => /(?:^|\/)(?:__main__|main|app)\.py$/.test(file.path))
    .map((file) => ({ path: file.path, startLine: 1, endLine: 1 }));
}
