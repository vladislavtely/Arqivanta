import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { analyzeRepository } from './index.ts';

async function withFixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const base = await realpath(tmpdir());
  const directory = await mkdtemp(join(base, 'arqivanta-flow-test-'));
  try {
    await Promise.all(
      Object.entries(files).map(([file, source]) => writeFile(join(directory, file), source)),
    );
    await run(directory);
  } finally {
    const resolved = await realpath(directory);
    if (dirname(resolved) === base && resolved === directory)
      await rm(resolved, { recursive: true, force: true });
  }
}

it('reuses unchanged syntax while re-resolving imports after a file disappears', async () => {
  await withFixture(
    {
      'page.ts': [
        "import Fastify from 'fastify';",
        "import { render as format } from './render.js';",
        'const app = Fastify();',
        "app.get('/report', () => format());",
        'export function ordinary() { return other(); }',
        'function other() { return 1; }',
        'export function shadowFallback(custom: () => number) { return custom(); }',
        'function custom() { return 99; }',
      ].join('\n'),
      'render.ts': 'export const render = () => "report";\n',
    },
    async (root) => {
      const first = await analyzeRepository(root);
      const page = first.files.find(({ path }) => path === 'page.ts')!;
      expect(page.flow).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'http:GET /report',
            registration: { path: 'page.ts', startLine: 4, endLine: 4 },
            calls: [
              expect.objectContaining({ binding: { module: './render.js', name: 'render' } }),
            ],
          }),
          expect.objectContaining({
            key: 'function:ordinary',
            calls: [expect.objectContaining({ binding: { name: 'function:other' } })],
          }),
          expect.objectContaining({
            key: 'function:shadowFallback',
            calls: [expect.objectContaining({ label: 'custom', binding: undefined })],
          }),
        ]),
      );
      expect(first.edges).toMatchObject([{ source: 'page.ts', target: 'render.ts' }]);
      await rm(join(root, 'render.ts'));
      const second = await analyzeRepository(root, { baseline: first });
      expect(second.analysisStats).toEqual({ parsed: 0, reused: 1 });
      expect(second.edges).toEqual([]);
      expect(second.files[0]!.imports).not.toContainEqual(
        expect.objectContaining({ resolvedPath: 'render.ts' }),
      );
      expect(page.imports).toContainEqual(expect.objectContaining({ resolvedPath: 'render.ts' }));
    },
  );
});

it('recognizes FastAPI router decorators and records named imports', async () => {
  await withFixture(
    {
      'app.py': [
        'from fastapi import APIRouter as Router',
        'from worker import make_report as render',
        'router = Router()',
        '@router.get("/report")',
        'def endpoint():',
        '    return render()',
      ].join('\n'),
      'worker.py': 'def make_report():\n    return "report"\n',
    },
    async (root) => {
      const result = await analyzeRepository(root);
      const app = result.files.find(({ path }) => path === 'app.py')!;
      expect(app.flow).toContainEqual(
        expect.objectContaining({
          key: 'http:GET /report',
          registration: { path: 'app.py', startLine: 4, endLine: 4 },
          calls: [
            expect.objectContaining({
              label: 'render',
              startLine: 6,
              binding: { name: 'make_report', module: 'worker.make_report' },
            }),
          ],
        }),
      );
      expect(app.imports).toContainEqual(
        expect.objectContaining({
          specifier: 'worker.make_report',
          resolvedPath: 'worker.py',
        }),
      );
    },
  );
});
