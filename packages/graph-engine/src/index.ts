import type { DependencyEdge, FileRecord, SourceRef } from '@arqivanta/shared';

export { buildFolderGraph, parentFolder } from './folders.ts';
export type { FolderLink } from './folders.ts';

export type GraphScope = 'all' | 'connected' | 'entry-points' | 'selected';

export type PositionedFile = {
  file: FileRecord;
  x: number;
  y: number;
  entryPoint: boolean;
};

type Options = {
  query?: string;
  scope?: GraphScope;
  selected?: string;
  maxFiles?: number;
  maxEdges?: number;
};

function comparePaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildGraphView(
  files: FileRecord[],
  edges: DependencyEdge[],
  entries: SourceRef[],
  options: Options = {},
) {
  const paths = new Set(files.map((file) => file.path));
  const entryPaths = new Set(entries.map((entry) => entry.path).filter((path) => paths.has(path)));
  const localEdges = edges.filter((edge) => paths.has(edge.source) && paths.has(edge.target));
  const connected = new Set<string>();
  const nearEntry = new Set(entryPaths);
  const nearSelection = new Set<string>();
  if (options.selected && paths.has(options.selected)) nearSelection.add(options.selected);
  for (const edge of localEdges) {
    connected.add(edge.source).add(edge.target);
    if (entryPaths.has(edge.source) || entryPaths.has(edge.target))
      nearEntry.add(edge.source).add(edge.target);
    if (edge.source === options.selected || edge.target === options.selected)
      nearSelection.add(edge.source).add(edge.target);
  }

  const query = options.query?.trim().toLowerCase() ?? '';
  const scope = { all: paths, connected, 'entry-points': nearEntry, selected: nearSelection }[
    options.scope ?? 'all'
  ];
  const matchedFiles = files
    .filter((file) => scope.has(file.path) && file.path.toLowerCase().includes(query))
    .sort((left, right) => comparePaths(left.path, right.path));
  const matchedPaths = new Set(matchedFiles.map((file) => file.path));
  const maxFiles = options.maxFiles ?? matchedFiles.length;
  const visibleFiles =
    matchedFiles.length > maxFiles
      ? matchedFiles
          .sort((left, right) => priority(left.path) - priority(right.path))
          .slice(0, maxFiles)
      : matchedFiles;

  function priority(path: string) {
    if (path === options.selected) return 0;
    if (entryPaths.has(path)) return 1;
    return connected.has(path) ? 2 : 3;
  }

  const visiblePaths = new Set(visibleFiles.map((file) => file.path));
  let matchingEdgeCount = 0;
  const visibleEdges: DependencyEdge[] = [];
  for (const edge of localEdges) {
    if (
      options.scope === 'selected' &&
      edge.source !== options.selected &&
      edge.target !== options.selected
    )
      continue;
    if (matchedPaths.has(edge.source) && matchedPaths.has(edge.target)) matchingEdgeCount++;
    if (visiblePaths.has(edge.source) && visiblePaths.has(edge.target)) visibleEdges.push(edge);
  }
  visibleEdges.sort(
    (left, right) =>
      comparePaths(left.source, right.source) || comparePaths(left.target, right.target),
  );
  if (options.maxEdges !== undefined && visibleEdges.length > options.maxEdges)
    visibleEdges.length = options.maxEdges;

  const outgoing = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of visibleEdges) {
    const targets = outgoing.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    } else {
      outgoing.set(edge.source, [edge.target]);
    }
    incoming.add(edge.target);
  }

  const rank = new Map<string, number>();
  const queue: string[] = [];
  function enqueue(path: string, depth: number) {
    if (rank.has(path)) return;
    rank.set(path, depth);
    queue.push(path);
  }

  let cursor = 0;
  function followDependencies() {
    while (cursor < queue.length) {
      const path = queue[cursor++];
      const depth = rank.get(path) ?? 0;
      for (const target of outgoing.get(path) ?? []) enqueue(target, depth + 1);
    }
  }

  for (const file of visibleFiles) if (entryPaths.has(file.path)) enqueue(file.path, 0);
  followDependencies();
  for (const file of visibleFiles)
    if (outgoing.has(file.path) && !incoming.has(file.path)) enqueue(file.path, 0);
  followDependencies();
  for (const file of visibleFiles) {
    if (!outgoing.has(file.path)) continue;
    enqueue(file.path, 0);
    followDependencies();
  }

  const rows = new Map<number, number>();
  const columns = Math.max(2, Math.min(6, (rank.size ? Math.max(...rank.values()) : 0) + 1));
  let orphanCount = 0;
  for (const file of visibleFiles) {
    if (rank.has(file.path)) continue;
    rank.set(file.path, orphanCount++ % columns);
  }

  const positioned = visibleFiles.map((file): PositionedFile => {
    const column = rank.get(file.path) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { file, x: column * 270, y: row * 95, entryPoint: entryPaths.has(file.path) };
  });
  return {
    files: positioned,
    edges: visibleEdges,
    matchingFileCount: matchedFiles.length,
    matchingEdgeCount,
  };
}
