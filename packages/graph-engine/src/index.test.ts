import type { DependencyEdge, FileRecord } from '@arqivanta/shared';
import { describe, expect, it } from 'vitest';
import { buildGraphView } from './index.ts';

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
});
