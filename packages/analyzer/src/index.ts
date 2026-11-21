import { comparePaths, isJavaScriptOrTypeScript, isPythonSource } from '@arqivanta/shared';
import type {
  AnalysisResult,
  DependencyEdge,
  Diagnostic,
  FileRecord,
  SourceFile,
} from '@arqivanta/shared';
import { discoverRepository } from './discover.ts';

const durationLimit = 20_000;
const diagnosticLimit = 1_000;
const relationshipLimit = 50_000;
const metadataLimit = 150_000;

function basicRecord(file: SourceFile, language = 'Text'): FileRecord {
  return {
    path: file.path,
    language,
    lines: file.source.split(/\r\n|[\n\r\u2028\u2029]/).length,
    bytes: file.bytes,
    imports: [],
    exports: [],
    symbols: [],
  };
}

function metadataLanguage(filePath: string) {
  const path = filePath.toLowerCase();
  if (path.endsWith('.json')) return 'JSON';
  if (path.endsWith('.md')) return 'Markdown';
  if (path.endsWith('.toml')) return 'TOML';
  return 'Text';
}

export async function analyzeRepository(
  root: string,
  options: { signal?: AbortSignal } = {},
): Promise<AnalysisResult> {
  const started = performance.now();
  function checkDeadline() {
    options.signal?.throwIfAborted();
    if (performance.now() - started > durationLimit)
      throw new Error('Repository analysis exceeded the time limit.');
  }

  const diagnostics: Diagnostic[] = [];
  function report(diagnostic: Diagnostic) {
    if (diagnostics.length < diagnosticLimit) diagnostics.push(diagnostic);
    else if (diagnostics.length === diagnosticLimit) {
      diagnostics.push({
        severity: 'warning',
        message: 'Additional analysis diagnostics were omitted.',
      });
    }
  }

  checkDeadline();
  const found = await discoverRepository(root, checkDeadline, report);
  const pythonFiles = found.filter((file) => isPythonSource(file.path));
  const [typescript, python] = await Promise.all([
    found.some((file) => isJavaScriptOrTypeScript(file.path))
      ? import('@arqivanta/analyzer-typescript')
      : undefined,
    pythonFiles.length ? import('@arqivanta/analyzer-python') : undefined,
  ]);
  const sources: Record<string, string> = Object.create(null) as Record<string, string>;
  const files: FileRecord[] = [];
  const invalid = new Set<string>();
  let metadataRemaining = metadataLimit;
  let metadataWarning = false;
  for (const file of found) {
    checkDeadline();
    sources[file.path] = file.source;
    try {
      const parser = isPythonSource(file.path)
        ? python
        : isJavaScriptOrTypeScript(file.path)
          ? typescript
          : undefined;
      const parsed =
        parser?.parseFile(file, (diagnostic, syntaxError) => {
          if (syntaxError) invalid.add(file.path);
          report(diagnostic);
        }) ?? basicRecord(file, metadataLanguage(file.path));
      for (const records of [parsed.imports, parsed.exports, parsed.symbols]) {
        if (records.length > metadataRemaining) {
          records.length = metadataRemaining;
          if (!metadataWarning)
            report({
              severity: 'warning',
              message:
                'The analysis metadata limit was reached. Some relationships and symbols were omitted.',
            });
          metadataWarning = true;
        }
        metadataRemaining -= records.length;
      }
      files.push(parsed);
    } catch {
      report({ severity: 'warning', path: file.path, message: 'This file could not be parsed.' });
      files.push(basicRecord(file));
    }
  }

  const typescriptFiles = python ? found.filter((file) => !isPythonSource(file.path)) : found;
  const resolveTypeScript = typescript?.createModuleResolver(typescriptFiles, report);
  const resolvePython = python?.createModuleResolver(pythonFiles);
  const edges: DependencyEdge[] = [];
  let relationships = 0;
  let limited = false;
  for (const file of files) {
    if (invalid.has(file.path) || !file.imports.length) continue;
    const usePython = isPythonSource(file.path);
    const resolve = usePython ? resolvePython : resolveTypeScript;
    const dependencies = new Map<string, DependencyEdge>();
    for (const item of file.imports) {
      checkDeadline();
      if (++relationships > relationshipLimit) {
        if (!limited)
          report({
            severity: 'warning',
            message:
              'The module resolution limit was reached. Additional imports remain unverified.',
          });
        limited = true;
        break;
      }
      let target: string | undefined;
      try {
        target = resolve?.(file.path, item.specifier, item.kind);
      } catch {
        report({
          severity: 'warning',
          path: file.path,
          line: item.startLine,
          message: 'An import could not be resolved safely.',
        });
      }
      if (!target) {
        if (
          (usePython && item.specifier.startsWith('.')) ||
          (!usePython &&
            (item.specifier === '.' ||
              item.specifier === '..' ||
              item.specifier.startsWith('./') ||
              item.specifier.startsWith('../')))
        ) {
          report({
            severity: 'info',
            path: file.path,
            line: item.startLine,
            message: 'A relative import could not be resolved to an analyzed file.',
          });
        }
        continue;
      }
      item.resolvedPath = target;
      let edge = dependencies.get(target);
      if (!edge) {
        edge = { source: file.path, target, references: [] };
        dependencies.set(target, edge);
        edges.push(edge);
      }
      if (
        !edge.references.some(
          (reference) =>
            reference.startLine === item.startLine && reference.endLine === item.endLine,
        )
      ) {
        edge.references.push({ path: file.path, startLine: item.startLine, endLine: item.endLine });
      }
    }
    if (limited) break;
  }

  const entryPoints = [
    ...(typescript && resolveTypeScript
      ? typescript.findEntryPoints(typescriptFiles, files, resolveTypeScript, checkDeadline)
      : []),
    ...(python?.findEntryPoints(pythonFiles) ?? []),
  ].sort((a, b) => comparePaths(a.path, b.path) || a.startLine - b.startLine);
  return {
    sources,
    files,
    edges: edges.sort(
      (a, b) => comparePaths(a.source, b.source) || comparePaths(a.target, b.target),
    ),
    entryPoints,
    diagnostics,
  };
}
