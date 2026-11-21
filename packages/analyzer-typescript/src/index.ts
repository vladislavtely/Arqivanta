import type { AnalysisResult, DependencyEdge, Diagnostic, FileRecord } from '@arqivanta/shared';
import { comparePaths, discoverRepository } from './discover.ts';
import { parseFile } from './parse.ts';
import { createModuleResolver, findEntryPoints } from './resolve.ts';

const durationLimit = 12_000;
const diagnosticLimit = 1_000;
const relationshipLimit = 20_000;
const metadataLimit = 60_000;

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
  const sources: Record<string, string> = Object.create(null) as Record<string, string>;
  const files: FileRecord[] = [];
  const invalid = new Set<string>();
  let metadataRemaining = metadataLimit;
  let metadataWarning = false;
  for (const file of found) {
    checkDeadline();
    sources[file.path] = file.source;
    try {
      const parsed = parseFile(file, (diagnostic, syntaxError) => {
        if (syntaxError) invalid.add(file.path);
        report(diagnostic);
      });
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
      files.push({
        path: file.path,
        language: 'Text',
        lines: file.source.split(/\r\n|[\n\r\u2028\u2029]/).length,
        bytes: file.bytes,
        imports: [],
        exports: [],
        symbols: [],
      });
    }
  }

  const resolve = createModuleResolver(found, report);
  const edges = new Map<string, DependencyEdge>();
  let relationships = 0;
  let limited = false;
  for (const file of files) {
    if (invalid.has(file.path)) continue;
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
        target = resolve(file.path, item.specifier, item.kind);
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
          item.specifier === '.' ||
          item.specifier === '..' ||
          item.specifier.startsWith('./') ||
          item.specifier.startsWith('../')
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
      const key = JSON.stringify([file.path, target]);
      const edge = edges.get(key) ?? { source: file.path, target, references: [] };
      if (
        !edge.references.some(
          (reference) =>
            reference.startLine === item.startLine && reference.endLine === item.endLine,
        )
      ) {
        edge.references.push({ path: file.path, startLine: item.startLine, endLine: item.endLine });
      }
      edges.set(key, edge);
    }
    if (limited) break;
  }

  const entryPoints = findEntryPoints(found, files, resolve, checkDeadline);
  return {
    sources,
    files,
    edges: [...edges.values()].sort(
      (a, b) => comparePaths(a.source, b.source) || comparePaths(a.target, b.target),
    ),
    entryPoints,
    diagnostics,
  };
}
