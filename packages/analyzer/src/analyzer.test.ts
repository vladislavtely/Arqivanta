import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from './index.ts';

const temporaryDirectories: string[] = [];

async function fixture(files: Record<string, string | Buffer>) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'arqivanta-analysis-'));
  temporaryDirectories.push(temporary);
  const root = path.join(temporary, 'project');
  await mkdir(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return { root, temporary };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('analyzeRepository', () => {
  it('parses AST relationships and resolves relative files, re-exports, and inherited TypeScript aliases', async () => {
    const source = [
      'import {',
      '  build,',
      "} from './lib.js';",
      "import { shared } from '@app/shared';",
      "export { build as run } from './lib.js';",
      'const deferred = import(`./late`);',
      "const legacy = require('./legacy.cjs');",
      'export const start = () => deferred;',
      "import 'external-lib';",
    ].join('\n');
    const { root } = await fixture({
      'package.json':
        '{"main": "./src/main.js", "bin": {"tool": "./tools/tool.js"}, "scripts": {"prepare": "exit 42"}}',
      'tsconfig.json': '{"extends": "./tsconfig.base.json"}',
      'tsconfig.base.json': '{"compilerOptions": {"paths": {"@app/*": ["./src/*"]}}}',
      'src/main.ts': source,
      'src/lib.ts': 'export function build() { return 1; }\n',
      'src/shared.ts': 'export const shared = 1;\n',
      'src/late/index.ts': 'export const late = 1;\n',
      'src/legacy.cts': 'module.exports = { ready: true };\n',
      'tools/tool.ts': "throw new Error('Source is never executed');",
      'README.md': '# Project',
    });

    const result = await analyzeRepository(root);
    expect(result).toEqual(await analyzeRepository(root));
    expect(result.files.map((file) => file.path)).toEqual([
      'README.md',
      'package.json',
      'src/late/index.ts',
      'src/legacy.cts',
      'src/lib.ts',
      'src/main.ts',
      'src/shared.ts',
      'tools/tool.ts',
      'tsconfig.base.json',
      'tsconfig.json',
    ]);
    expect(result.sources['src/main.ts']).toBe(source);
    expect(Object.getPrototypeOf(result.sources)).toBeNull();
    expect(result.files.find((file) => file.path === 'src/main.ts')).toMatchObject({
      language: 'TypeScript',
      bytes: Buffer.byteLength(source),
      lines: 9,
      exports: [
        { name: 'run', kind: 're-export', startLine: 5, endLine: 5 },
        { name: 'start', kind: 'function', startLine: 8, endLine: 8 },
      ],
      imports: expect.arrayContaining([
        {
          specifier: './lib.js',
          kind: 'import',
          resolvedPath: 'src/lib.ts',
          startLine: 1,
          endLine: 3,
        },
        {
          specifier: '@app/shared',
          kind: 'import',
          resolvedPath: 'src/shared.ts',
          startLine: 4,
          endLine: 4,
        },
        {
          specifier: './late',
          kind: 'dynamic import',
          resolvedPath: 'src/late/index.ts',
          startLine: 6,
          endLine: 6,
        },
        {
          specifier: './legacy.cjs',
          kind: 'require',
          resolvedPath: 'src/legacy.cts',
          startLine: 7,
          endLine: 7,
        },
        { specifier: 'external-lib', kind: 'side-effect import', startLine: 9, endLine: 9 },
      ]),
    });
    expect(result.edges).toHaveLength(4);
    expect(result.edges.find((edge) => edge.target === 'src/lib.ts')?.references).toEqual([
      { path: 'src/main.ts', startLine: 1, endLine: 3 },
      { path: 'src/main.ts', startLine: 5, endLine: 5 },
    ]);
    expect(result.entryPoints).toEqual([
      { path: 'src/main.ts', startLine: 1, endLine: 1 },
      { path: 'tools/tool.ts', startLine: 1, endLine: 1 },
    ]);
  });

  it('honors ignore files and skips sensitive files, unsupported data, and oversized or invalid source', async () => {
    const { root, temporary } = await fixture({
      '.git/info/exclude': 'local-only.ts\n',
      '.gitignore': 'ignored.ts\nconfig/\n',
      '.env.local.ts': 'export const bad = true;',
      '.ssh/package.json': '{"private": true}',
      'credentials.ts': 'export const bad = true;',
      'config/index.ts': 'export const bad = true;',
      'ignored.ts': 'export const bad = true;',
      'local-only.ts': 'export const bad = true;',
      'node_modules/p/index.js': 'export const bad = true;',
      'nested/.gitignore': '*.ts\n!ok.ts\n',
      'nested/ignored.ts': 'export const bad = true;',
      'nested/ok.ts': 'export const ok = true;',
      'invalid.ts': Buffer.from([0xff]),
      'too-large.ts': Buffer.alloc(384 * 1024 + 1, 'a'),
      'src/main.ts': "import '../ignored';\nimport '../../outside';",
      'outside.toml': 'unsupported = true',
    });
    await writeFile(path.join(temporary, 'outside.ts'), 'export const outside = true;');

    const result = await analyzeRepository(root);
    expect(Object.keys(result.sources)).toEqual(['nested/ok.ts', 'src/main.ts']);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'too-large.ts', severity: 'warning' }),
        expect.objectContaining({ path: 'invalid.ts', severity: 'warning' }),
        expect.objectContaining({ path: 'src/main.ts', severity: 'info' }),
      ]),
    );
  });

  it('does not follow directory symlinks', async ({ skip }) => {
    const { root, temporary } = await fixture({ 'index.ts': "import './junction/index';" });
    const outside = path.join(temporary, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'index.ts'), 'export const outside = true;');
    try {
      await symlink(outside, path.join(root, 'junction'), 'junction');
    } catch (error) {
      if (
        process.platform === 'win32' &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        skip();
        return;
      }
      throw error;
    }
    const result = await analyzeRepository(root);
    expect(Object.keys(result.sources)).toEqual(['index.ts']);
    expect(result.edges).toEqual([]);
  });

  it('does not read hardlinks that may reference paths outside the selected directory', async ({
    skip,
  }) => {
    const { root, temporary } = await fixture({ 'index.ts': "import './linked';" });
    const outside = path.join(temporary, 'outside.ts');
    await writeFile(outside, 'export const outside = true;');
    try {
      await link(outside, path.join(root, 'linked.ts'));
    } catch (error) {
      if (
        process.platform === 'win32' &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        skip();
        return;
      }
      throw error;
    }
    const result = await analyzeRepository(root);
    expect(Object.keys(result.sources)).toEqual(['index.ts']);
    expect(result.edges).toEqual([]);
  });

  it('keeps malformed and shadowed imports unverified', async () => {
    const { root } = await fixture({
      'bad.ts': "import './local';\nexport const broken = ;",
      'local.ts': 'export const value = true;',
      'shadowed.ts':
        "const require = (name: string) => name;\nrequire('./local');\nconst variable = './local';\nimport(variable);",
    });
    const result = await analyzeRepository(root);
    expect(result.edges).toEqual([]);
    expect(result.files.find((file) => file.path === 'shadowed.ts')?.imports).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: 'bad.ts', line: 2, severity: 'warning' }),
    );
  });

  it('respects NodeNext module formats when resolving imports', async () => {
    const { root } = await fixture({
      'tsconfig.json': '{"compilerOptions": {"module": "NodeNext"}}',
      'package.json': '{"type": "commonjs"}',
      'index.ts': "import './util';",
      'util.ts': 'export const value = true;',
      'esm/package.json': '{"type": "module"}',
      'esm/index.ts': "import './util';\nimport './util.js';",
      'esm/util.ts': 'export const value = true;',
    });
    expect((await analyzeRepository(root)).edges).toEqual([
      {
        source: 'esm/index.ts',
        target: 'esm/util.ts',
        references: [{ path: 'esm/index.ts', startLine: 2, endLine: 2 }],
      },
      {
        source: 'index.ts',
        target: 'util.ts',
        references: [{ path: 'index.ts', startLine: 1, endLine: 1 }],
      },
    ]);
  });

  it('reads a worktree while leaving Git metadata off the file tree and honors cancellation', async () => {
    const { root } = await fixture({
      '.git': 'gitdir: ../.git/worktrees/project',
      'index.ts': 'export const value = true;',
    });
    expect((await analyzeRepository(root)).files.map((file) => file.path)).toEqual(['index.ts']);
    await expect(
      analyzeRepository(root, { signal: AbortSignal.abort(new Error('Cancelled')) }),
    ).rejects.toThrow('Cancelled');
  });
});
