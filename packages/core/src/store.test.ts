import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openProjectStore } from './index.ts';

it('persists a pinned snapshot and its source across connections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arqivanta-storage-test-'));
  const filename = join(directory, 'projects.sqlite');
  let store = openProjectStore(filename);
  try {
    const key = 'github:example:commit';
    const result = store.save(
      { name: 'example/project', origin: 'github', commitSha: 'a'.repeat(40) },
      {
        files: [],
        edges: [],
        entryPoints: [],
        diagnostics: [],
        sources: { 'index.ts': 'export const name = "example";' },
      },
      key,
    );
    store.close();
    store = openProjectStore(filename);
    expect(store.cached(key)).toEqual(result);
    expect(store.get(result.project.id)).toEqual(result);
    expect(store.list()).toEqual([result.project]);
    expect(store.source(result.project.id, 'index.ts')).toContain('export const name');
    expect(store.source(result.project.id, '__proto__')).toBeUndefined();
    expect(
      store.save(
        { name: 'same commit', origin: 'github' },
        { files: [], edges: [], entryPoints: [], diagnostics: [], sources: {} },
        key,
      ),
    ).toEqual(result);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
