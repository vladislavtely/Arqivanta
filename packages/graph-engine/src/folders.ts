import { comparePaths } from '@arqivanta/shared';
import type { DependencyEdge, FileRecord } from '@arqivanta/shared';

export function parentFolder(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

type Folder = {
  path: string;
  fileCount: number;
  internal: number;
  incoming: number;
  outgoing: number;
};

export type FolderLink = {
  source: string;
  target: string;
  count: number;
  examples: DependencyEdge[];
};

export function buildFolderGraph(
  files: FileRecord[],
  edges: DependencyEdge[],
  {
    query = '',
    maxFolders = 48,
    maxLinks = 120,
  }: { query?: string; maxFolders?: number; maxLinks?: number } = {},
) {
  const search = query.trim().toLowerCase();
  const folderByFile = new Map<string, string>();
  const folders = new Map<string, Folder>();
  const matches = new Set<string>();
  for (const file of files) {
    const path = parentFolder(file.path);
    folderByFile.set(file.path, path);
    const folder = folders.get(path) ?? {
      path,
      fileCount: 0,
      internal: 0,
      incoming: 0,
      outgoing: 0,
    };
    folder.fileCount++;
    folders.set(path, folder);
    if (file.path.toLowerCase().includes(search) || (!path && 'repository root'.includes(search)))
      matches.add(path);
  }

  const links = new Map<string, FolderLink>();
  for (const edge of edges) {
    const source = folderByFile.get(edge.source);
    const target = folderByFile.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (source === target) {
      folders.get(source)!.internal++;
      continue;
    }
    folders.get(source)!.outgoing++;
    folders.get(target)!.incoming++;
    if (!matches.has(source) || !matches.has(target)) continue;
    const key = JSON.stringify([source, target]);
    const link = links.get(key) ?? { source, target, count: 0, examples: [] };
    link.count++;
    if (link.examples.length < 8) link.examples.push(edge);
    links.set(key, link);
  }

  const visible = [...folders.values()]
    .filter((folder) => matches.has(folder.path))
    .sort(
      (a, b) =>
        b.incoming + b.outgoing - a.incoming - a.outgoing ||
        b.fileCount - a.fileCount ||
        comparePaths(a.path, b.path),
    )
    .slice(0, maxFolders)
    .sort(
      (a, b) => b.outgoing - b.incoming - (a.outgoing - a.incoming) || comparePaths(a.path, b.path),
    );
  const paths = new Set(visible.map(({ path }) => path));
  const visibleLinks = [...links.values()]
    .filter((link) => paths.has(link.source) && paths.has(link.target))
    .sort(
      (a, b) =>
        b.count - a.count || comparePaths(a.source, b.source) || comparePaths(a.target, b.target),
    )
    .slice(0, maxLinks);

  const columns = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(visible.length * 1.5))));
  return {
    folders: visible.map((folder, index) => ({
      ...folder,
      x: (index % columns) * 320,
      y: Math.floor(index / columns) * 166 + ((index % columns) % 2) * 72,
    })),
    links: visibleLinks,
    matchingFolderCount: matches.size,
    matchingLinkCount: links.size,
  };
}
