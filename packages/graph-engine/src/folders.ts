import { comparePaths } from '@arqivanta/shared';
import type { DependencyEdge, FileRecord } from '@arqivanta/shared';

export function parentFolder(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

type Directory = {
  path: string;
  children: Directory[];
  files: FileRecord[];
  fileCount: number;
};

const workspaceContainers = new Set(['apps', 'packages', 'libs', 'services']);

type GroupNode = {
  id: string;
  path: string;
  kind: 'folder';
  expanded: boolean;
  fileCount: number;
  hiddenChildren: number;
};

type FileNode = { id: string; path: string; kind: 'file'; file: FileRecord };
type GroupedNode = GroupNode | FileNode;
export type GroupedLink = {
  source: string;
  target: string;
  count: number;
  dependencies: DependencyEdge[];
};

export function indexFolderGraph(files: FileRecord[], edges: DependencyEdge[]) {
  const directories = new Map<string, Directory>();
  function directory(path: string): Directory {
    const existing = directories.get(path);
    if (existing) return existing;
    const item: Directory = { path, children: [], files: [], fileCount: 0 };
    directories.set(path, item);
    if (path) directory(parentFolder(path)).children.push(item);
    return item;
  }
  const root = directory('');
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    directory(parentFolder(file.path)).files.push(file);
  }
  function prepare(item: Directory): number {
    item.children.sort((a, b) => comparePaths(a.path, b.path));
    item.files.sort((a, b) => comparePaths(a.path, b.path));
    item.fileCount = item.children.reduce((sum, child) => sum + prepare(child), item.files.length);
    return item.fileCount;
  }
  prepare(root);
  const roots = [...root.children];
  if (root.files.length)
    roots.unshift({ path: '', children: [], files: root.files, fileCount: root.files.length });
  const localEdges = edges
    .filter((edge) => paths.has(edge.source) && paths.has(edge.target))
    .sort((a, b) => comparePaths(a.source, b.source) || comparePaths(a.target, b.target));
  const initialExpansion = new Set(
    roots
      .filter((item) => workspaceContainers.has(item.path) && !item.files.length)
      .map((item) => item.path),
  );
  return { roots, edges: localEdges, initialExpansion };
}

function folderNodeId(path: string) {
  return 'folder:' + path;
}

function fileNodeId(path: string) {
  return 'file:' + path;
}

export function groupDependencyGraph(
  index: ReturnType<typeof indexFolderGraph>,
  {
    expanded = new Set<string>(),
    priorityPath,
    query = '',
    maxNodes = 72,
    maxLinks = 160,
    maxChildren = 24,
    maxRoots = 36,
  }: {
    expanded?: ReadonlySet<string>;
    priorityPath?: string;
    query?: string;
    maxNodes?: number;
    maxLinks?: number;
    maxChildren?: number;
    maxRoots?: number;
  } = {},
) {
  const search = query.trim().toLowerCase();
  const matchesFile = (file: FileRecord) => file.path.toLowerCase().includes(search);
  const matches = new Set<Directory>();
  function matchDirectory(item: Directory): boolean {
    const childMatches = item.children.map(matchDirectory).some(Boolean);
    const matched =
      childMatches ||
      (item.path || 'Repository root').toLowerCase().includes(search) ||
      item.files.some(matchesFile);
    if (matched) matches.add(item);
    return matched;
  }
  if (search) index.roots.forEach(matchDirectory);
  const eligible = (item: Directory) => !search || matches.has(item);

  const nodes: GroupedNode[] = [];
  const folderIndexes = new Map<string, number>();
  const fileIndexes = new Map<string, number>();
  const frontier: { directory: Directory; group: GroupNode }[] = [];
  function addFolder(item: Directory) {
    const id = folderNodeId(item.path);
    const isExpanded = expanded.has(item.path);
    const group: GroupNode = {
      id,
      kind: 'folder',
      path: item.path,
      fileCount: item.fileCount,
      expanded: isExpanded,
      hiddenChildren: 0,
    };
    folderIndexes.set(item.path, nodes.length);
    nodes.push(group);
    if (isExpanded) {
      const entry = { directory: item, group };
      if (priorityPath === item.path || (item.path && priorityPath?.startsWith(item.path + '/')))
        frontier.unshift(entry);
      else frontier.push(entry);
    }
  }
  const roots = index.roots.filter(eligible);
  const visibleRoots = roots.slice(0, Math.min(maxRoots, maxNodes));
  visibleRoots.forEach(addFolder);
  let omittedNodes = roots.length - visibleRoots.length;
  while (frontier.length) {
    const { directory: item, group } = frontier.shift()!;
    const children = item.children.filter(eligible);
    const files =
      search && !(item.path === '' && search === 'repository root')
        ? item.files.filter(matchesFile)
        : item.files;
    const preferred = children.find(
      (child) => priorityPath === child.path || priorityPath?.startsWith(child.path + '/'),
    );
    const available = maxNodes - nodes.length;
    // Leave room for the folder being opened before spending the budget on its siblings.
    const deeperLevels =
      preferred && priorityPath
        ? priorityPath.slice(preferred.path.length).split('/').length - 1
        : 0;
    const reserve =
      preferred && available > 1 ? Math.min(available - 1, maxChildren + deeperLevels) : 0;
    const limit = Math.min(maxChildren, available - reserve);
    const folders = children
      .sort(
        (a, b) =>
          Number(b === preferred) - Number(a === preferred) ||
          Number(expanded.has(b.path)) - Number(expanded.has(a.path)),
      )
      .slice(0, limit);
    folders.forEach(addFolder);
    const visibleFiles = files.slice(0, limit - folders.length);
    for (const file of visibleFiles) {
      const id = fileNodeId(file.path);
      fileIndexes.set(file.path, nodes.length);
      nodes.push({ id, kind: 'file', path: file.path, file });
    }
    group.hiddenChildren = children.length + files.length - folders.length - visibleFiles.length;
    omittedNodes += group.hiddenChildren;
  }

  const endpoints = new Map<string, number>();
  function assignEndpoints(item: Directory, inherited?: number) {
    const group = folderIndexes.get(item.path) ?? inherited;
    if (group === undefined) return;
    for (const file of item.files) {
      endpoints.set(file.path, fileIndexes.get(file.path) ?? group);
    }
    for (const child of item.children) assignEndpoints(child, group);
  }
  for (const root of visibleRoots) assignEndpoints(root);

  const links = new Map<number, GroupedLink & { fileEndpoints: number }>();
  for (const edge of index.edges) {
    const source = endpoints.get(edge.source);
    const target = endpoints.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (source === target && nodes[source].kind === 'folder') continue;
    // The visible node indexes are dense, so each ordered pair has a unique numeric key.
    const key = source * nodes.length + target;
    const link = links.get(key) ?? {
      source: nodes[source].id,
      target: nodes[target].id,
      fileEndpoints: Number(nodes[source].kind === 'file') + Number(nodes[target].kind === 'file'),
      count: 0,
      dependencies: [],
    };
    link.count++;
    link.dependencies.push(edge);
    links.set(key, link);
  }

  const visibleLinks = [...links.values()]
    .sort(
      (a, b) =>
        b.fileEndpoints - a.fileEndpoints ||
        b.count - a.count ||
        comparePaths(a.source, b.source) ||
        comparePaths(a.target, b.target),
    )
    .slice(0, maxLinks)
    .map(({ source, target, count, dependencies }): GroupedLink => ({
      source,
      target,
      count,
      dependencies,
    }));

  const columns = 4;
  return {
    nodes: nodes.map((node, i) => ({
      ...node,
      x: (i % columns) * 320,
      y: Math.floor(i / columns) * 140 + ((i % columns) % 2) * 48,
    })),
    links: visibleLinks,
    omittedNodes,
    omittedLinks: links.size - visibleLinks.length,
  };
}

export function folderDependencyCounts(edges: DependencyEdge[], path: string) {
  const prefix = path + '/';
  const contains = (file: string) => (path ? file.startsWith(prefix) : !file.includes('/'));
  const counts = { internal: 0, incoming: 0, outgoing: 0 };
  for (const { source, target } of edges) {
    const from = contains(source);
    const to = contains(target);
    if (from && to) counts.internal++;
    else if (from) counts.outgoing++;
    else if (to) counts.incoming++;
  }
  return counts;
}
