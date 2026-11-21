import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { analyzeRepository } from './index.ts';

it('finds Python symbols and resolves local imports in a mixed-language repository', async () => {
  const temporary = await realpath(tmpdir());
  const root = await mkdtemp(join(temporary, 'arqivanta-python-test-'));
  const files = {
    'src/tool/__init__.py': '"""Sample package."""\n',
    'src/tool/main.py': [
      'import os, tool.config as config',
      'from . import helpers as fmt',
      'from .helpers import (',
      '    format_task as output,',
      ')',
      '',
      '@decorator',
      'def run():',
      '    from . import config',
      '    print(output())',
    ].join('\n'),
    'src/tool/helpers.py': 'class Display:\n    pass\n\ndef format_task():\n    return "ok"\n',
    'src/tool/config.pyi': 'class Config: ...\n',
    'src/tool/broken.py': 'from . import helpers\ndef broken(:\n',
    'src/tool/up.py': 'from ... import private\n',
    'src/tool/__pycache__/temp.py': 'raise RuntimeError("excluded")\n',
    'venv/lib/site-packages/vendor.py': 'raise RuntimeError("excluded")\n',
    'pyproject.toml': '[project]\nname = "tool"\n',
    'private.py': 'TOKEN = "fixture"\n',
    '.gitignore': 'private.py\n',
    'scripts/index.ts': 'import { task } from "./task.ts";\nexport { task };\n',
    'scripts/task.ts': 'export const task = 1;\n',
  };
  try {
    for (const [path, source] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    const result = await analyzeRepository(root);
    const main = result.files.find((file) => file.path === 'src/tool/main.py');
    expect(main).toMatchObject({
      language: 'Python',
      symbols: [{ name: 'run', kind: 'function', startLine: 7, endLine: 10 }],
      imports: expect.arrayContaining([
        expect.objectContaining({ specifier: 'os' }),
        expect.objectContaining({ specifier: 'tool.config', resolvedPath: 'src/tool/config.pyi' }),
        expect.objectContaining({
          specifier: '.helpers.format_task',
          startLine: 3,
          endLine: 5,
          resolvedPath: 'src/tool/helpers.py',
        }),
      ]),
    });
    expect(main?.imports.find((item) => item.specifier === 'os')?.resolvedPath).toBeUndefined();
    expect(result.files.find((file) => file.path === 'pyproject.toml')?.language).toBe('TOML');
    expect(result.edges.map(({ source, target }) => [source, target])).toEqual([
      ['scripts/index.ts', 'scripts/task.ts'],
      ['src/tool/main.py', 'src/tool/config.pyi'],
      ['src/tool/main.py', 'src/tool/helpers.py'],
    ]);
    expect(result.entryPoints).toContainEqual({
      path: 'src/tool/main.py',
      startLine: 1,
      endLine: 1,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: 'src/tool/broken.py', message: 'Python syntax error.' }),
    );
    expect(result.sources).not.toHaveProperty('private.py');
    expect(result.sources).not.toHaveProperty('src/tool/__pycache__/temp.py');
    expect(result.sources).not.toHaveProperty('venv/lib/site-packages/vendor.py');
  } finally {
    const resolved = await realpath(root);
    if (dirname(resolved) === temporary && resolved === root) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
});
