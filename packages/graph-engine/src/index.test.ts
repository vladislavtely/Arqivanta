import type { DependencyEdge, FileRecord } from '@arqivanta/shared';
import { describe, expect, it } from 'vitest';
import { buildFolderGraph, buildGraphView } from './index.ts';

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

it('aggregates directed folder links and counts internal edges separately', () => {
  const files = [
    'tests/first.py',
    'tests/second.py',
    'app/main.py',
    'app/util.py',
    'README.md',
  ].map(file);
  const edges = [
    edge('tests/first.py', 'app/main.py'),
    edge('tests/second.py', 'app/util.py'),
    edge('app/main.py', 'app/util.py'),
    edge('app/util.py', 'missing.py'),
    edge('app/main.py', 'tests/second.py'),
  ];
  const graph = buildFolderGraph(files, edges);
  expect(graph.folders).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'tests', fileCount: 2, outgoing: 2 }),
      expect.objectContaining({ path: 'app', fileCount: 2, incoming: 2, internal: 1 }),
      expect.objectContaining({ path: '', fileCount: 1 }),
    ]),
  );
  expect(graph.links).toEqual([
    { source: 'tests', target: 'app', count: 2, examples: edges.slice(0, 2) },
    { source: 'app', target: 'tests', count: 1, examples: [edges[4]] },
  ]);
  expect(buildFolderGraph(files, edges, { query: 'util.py' })).toMatchObject({
    folders: [expect.objectContaining({ path: 'app', fileCount: 2 })],
    links: [],
    matchingFolderCount: 1,
  });
});
