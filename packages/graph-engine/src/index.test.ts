import type { DependencyEdge, FileRecord } from '@arqivanta/shared';
import { describe, expect, it } from 'vitest';
import {
  buildGraphView,
  folderDependencyCounts,
  groupDependencyGraph,
  indexFolderGraph,
} from './index.ts';

function file(path: string): FileRecord {
  return {
    path,
    bytes: 0,
    lines: 1,
    language: 'TypeScript',
    imports: [],
    exports: [],
    symbols: [],
  };
}

function edge(source: string, target: string): DependencyEdge {
  return { source, target, references: [{ path: source, startLine: 1, endLine: 1 }] };
}

describe('buildGraphView', () => {
  const files = ['src/index.ts', 'src/helpers.ts', 'src/config.ts', 'script.ts'].map(file);
  const edges = [
    edge('src/index.ts', 'src/helpers.ts'),
    edge('src/helpers.ts', 'src/config.ts'),
    edge('src/config.ts', 'src/helpers.ts'),
    edge('src/helpers.ts', 'external.ts'),
  ];
  const entries = [{ path: 'src/index.ts', startLine: 1, endLine: 1 }];

  it('lays out entry-point dependencies deterministically when the graph has a cycle', () => {
    const result = buildGraphView(files, edges, entries);
    const x = (path: string) => result.files.find((item) => item.file.path === path)?.x;
    expect(x('src/index.ts')).toBe(0);
    expect(x('src/helpers.ts')).toBeGreaterThan(x('src/index.ts')!);
    expect(x('src/config.ts')).toBeGreaterThan(x('src/helpers.ts')!);
    expect(result.edges).toHaveLength(3);
    expect(buildGraphView([...files].reverse(), [...edges].reverse(), entries)).toEqual(result);
  });

  it('keeps only files and verified edges visible within the chosen scope', () => {
    const entryView = buildGraphView(files, edges, entries, { scope: 'entry-points' });
    expect(entryView.files.map(({ file: item }) => item.path)).toEqual([
      'src/helpers.ts',
      'src/index.ts',
    ]);
    expect(entryView.edges).toEqual([edges[0]]);
    const searched = buildGraphView(files, edges, entries, {
      scope: 'connected',
      query: ' CONFIG ',
    });
    expect(searched.files.map(({ file: item }) => item.path)).toEqual(['src/config.ts']);
    expect(searched.edges).toEqual([]);
  });

  it('focuses on both directions around a selected file and caps only the visible graph', () => {
    const focused = buildGraphView(files, edges, entries, {
      scope: 'selected',
      selected: 'src/helpers.ts',
    });
    expect(focused.files.map(({ file: item }) => item.path)).toEqual([
      'src/config.ts',
      'src/helpers.ts',
      'src/index.ts',
    ]);
    expect(focused.edges).toHaveLength(3);

    const capped = buildGraphView(files, edges, entries, { maxFiles: 2, maxEdges: 0 });
    expect(capped.files.map(({ file: item }) => item.path)).toContain('src/index.ts');
    expect(capped).toMatchObject({ edges: [], matchingFileCount: 4, matchingEdgeCount: 3 });
    const searched = buildGraphView(files, edges, entries, { query: 'script', maxFiles: 2 });
    expect(searched.files.map(({ file: item }) => item.path)).toEqual(['script.ts']);
  });

  it('omits links only between neighbors in selected-file mode', () => {
    const direct = edge('src/index.ts', 'src/config.ts');
    const related = [...edges, direct];
    const focused = buildGraphView(files, related, entries, {
      scope: 'selected',
      selected: 'src/index.ts',
    });
    expect(focused.files).toHaveLength(3);
    expect(focused.edges).toEqual([direct, edges[0]]);
  });
});

it('projects directed links and retains each verified dependency after nested expansion', () => {
  const files = [
    'tests/first.py',
    'tests/second.py',
    'app/api/main.py',
    'app/util.py',
    'README.md',
  ].map(file);
  const edges = [
    edge('tests/first.py', 'app/api/main.py'),
    edge('tests/second.py', 'app/util.py'),
    edge('app/api/main.py', 'app/util.py'),
    edge('app/util.py', 'missing.py'),
    edge('app/api/main.py', 'tests/second.py'),
  ];
  const index = indexFolderGraph(files, edges);
  const graph = groupDependencyGraph(index);
  expect(graph.nodes.map(({ id }) => id)).toEqual(['folder:', 'folder:app', 'folder:tests']);
  expect(folderDependencyCounts(index.edges, 'app')).toEqual({
    incoming: 2,
    outgoing: 1,
    internal: 1,
  });
  expect(graph.links).toEqual([
    { source: 'folder:tests', target: 'folder:app', count: 2, dependencies: edges.slice(0, 2) },
    { source: 'folder:app', target: 'folder:tests', count: 1, dependencies: [edges[4]] },
  ]);
  const expanded = new Set(['app', 'app/api']);
  const open = groupDependencyGraph(index, { expanded });
  expect(open.links).toEqual(
    expect.arrayContaining([
      {
        source: 'folder:tests',
        target: 'file:app/api/main.py',
        count: 1,
        dependencies: [edges[0]],
      },
      {
        source: 'file:app/api/main.py',
        target: 'folder:tests',
        count: 1,
        dependencies: [edges[4]],
      },
      {
        source: 'file:app/api/main.py',
        target: 'file:app/util.py',
        count: 1,
        dependencies: [edges[2]],
      },
    ]),
  );
  expect(open).toEqual(
    groupDependencyGraph(indexFolderGraph([...files].reverse(), [...edges].reverse()), {
      expanded,
    }),
  );
  expect(
    groupDependencyGraph(index, { expanded, query: 'util.py' }).nodes.map(({ id }) => id),
  ).toEqual(['folder:app', 'file:app/util.py']);
});

it('hits display limits without capping the evidence behind visible grouped links', () => {
  const files = Array.from({ length: 600 }, (_, id) => file('app/file-' + id + '.ts'));
  const target = file('lib/index.ts');
  const index = indexFolderGraph(
    [...files, target],
    files.map(({ path }) => edge(path, target.path)),
  );
  const expanded = new Set(['app']);
  const open = groupDependencyGraph(index, { expanded });
  expect(open.nodes).toHaveLength(26);
  expect(open.omittedNodes).toBe(576);
  expect(open.links.reduce((total, link) => total + link.count, 0)).toBe(600);
  expect(open.links.find(({ source }) => source === 'folder:app')?.dependencies).toHaveLength(576);
  expect(
    groupDependencyGraph(index, { expanded, query: 'file-599' }).nodes.map(({ id }) => id),
  ).toContain('file:app/file-599.ts');
  const limited = groupDependencyGraph(index, { expanded, maxLinks: 2 });
  expect(limited.links).toHaveLength(2);
  expect(limited.omittedLinks).toBe(23);
});

it('keeps the root folder ID distinct from file paths', () => {
  const index = indexFolderGraph(
    [file('folder:.ts'), file('app/index.ts')],
    [edge('folder:.ts', 'app/index.ts')],
  );
  expect(groupDependencyGraph(index, { expanded: new Set(['']) }).links[0]).toMatchObject({
    source: 'file:folder:.ts',
    target: 'folder:app',
  });
});

it('opens workspace containers by default and keeps room for the requested branch', () => {
  const files = [
    ...Array.from({ length: 40 }, (_, id) => file('packages/pkg-' + id + '/index.ts')),
    file('packages/pkg-39/nested/file.ts'),
  ];
  const index = indexFolderGraph(files, []);
  expect([...index.initialExpansion]).toEqual(['packages']);
  const selected = 'packages/pkg-39/nested';
  const { nodes } = groupDependencyGraph(index, {
    expanded: new Set([...index.initialExpansion, 'packages/pkg-39', selected]),
    priorityPath: selected,
    maxNodes: 12,
  });
  expect(nodes.length).toBeLessThanOrEqual(12);
  expect(nodes.map(({ id }) => id)).toContain('file:packages/pkg-39/nested/file.ts');
});
