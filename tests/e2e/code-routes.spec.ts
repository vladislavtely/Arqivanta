import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';

test('traces a route, saves it, refreshes changed syntax and compares with Git HEAD', async ({
  page,
}) => {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'arqivanta-route-browser-'));
  function git(...args: string[]) {
    execFileSync('git', ['-C', root, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  }
  try {
    await mkdir(join(root, 'tests'));
    await Promise.all([
      writeFile(join(root, '.gitattributes'), 'formatter.ts export-ignore\n'),
      writeFile(
        join(root, 'routes.ts'),
        [
          "import Fastify from 'fastify';",
          "import { render as makeReport } from './formatter.js';",
          'const app = Fastify();',
          "app.get('/report', () => makeReport());",
          '',
        ].join('\n'),
      ),
      writeFile(
        join(root, 'formatter.ts'),
        'export function render() {\n  return "original";\n}\n',
      ),
      writeFile(join(root, 'tests', 'report.test.ts'), "import '../routes.js';\n"),
    ]);
    git('init', '-q');
    git('add', '--all');
    git(
      '-c',
      'user.name=Arqivanta Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Fixture',
    );

    await page.goto('/');
    await page.getByLabel('Project folder').fill(root);
    await page.getByRole('button', { name: 'Analyze folder' }).click();
    await expect(page.getByRole('heading', { name: 'Repository Explorer' })).toBeVisible();
    const routes = page.getByRole('button', { name: 'Code Routes', exact: true });
    await routes.click();
    await page.getByRole('button', { name: /GET \/report.*routes\.ts/ }).click();
    const steps = page.getByRole('list', { name: 'Trace steps' });
    await expect(steps).toContainText('Direct reference');
    await steps.getByRole('button', { name: 'Definition formatter.ts:1–3' }).click();
    const source = page.getByRole('region', { name: 'Source code' });
    await expect(source).toContainText('original');
    await expect(source.locator('.code-line.active')).toHaveCount(3);
    await routes.click();
    await page.getByLabel('Trace name').fill('Report walkthrough');
    await page.getByRole('button', { name: 'Save trace', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Trace saved.');

    await writeFile(
      join(root, 'formatter.ts'),
      '// Shift the implementation down.\nexport function render() {\n  return "revised";\n}\n',
    );
    await page.getByRole('button', { name: 'Refresh snapshot' }).click();
    await expect(page.getByText('2 files reused · 1 file parsed')).toBeVisible();
    await page.getByRole('button', { name: 'Report walkthrough' }).click();
    await expect(page.getByText('1 changed · 0 added · 0 removed')).toBeVisible();
    await page.getByRole('button', { name: 'Saved trace', exact: true }).click();
    await steps.getByRole('button', { name: 'Definition formatter.ts:1–3' }).click();
    const previous = page.getByRole('dialog', { name: 'Snapshot source' });
    await expect(previous).toContainText('original');
    await previous.getByRole('button', { name: 'Close source' }).click();
    await page.getByRole('button', { name: 'Current trace' }).click();
    await expect(steps.getByRole('button', { name: 'Definition formatter.ts:2–4' })).toBeVisible();
    await steps.getByRole('button', { name: 'Update saved step render' }).click();
    await expect(page.getByText('Saved step updated.')).toBeVisible();
    await expect(page.getByText('0 changed · 0 added · 0 removed')).toBeVisible();

    await page.getByRole('button', { name: 'Compare changes' }).click();
    await page.getByRole('button', { name: 'Compare with Git HEAD' }).click();
    await expect(page.getByText('0 added · 1 modified · 0 removed files')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Potentially affected callers' })).toBeVisible();
    await expect(page.getByText(/GET \/report.*routes\.ts.*direct/)).toBeVisible();
    await page.getByRole('checkbox', { name: 'Show related tests only' }).check();
    await page.getByText(/tests\/report\.test\.ts.*2 hops/).click();
    await expect(page.getByRole('button', { name: 'routes.ts:2', exact: true })).toBeVisible();
  } finally {
    const resolved = await realpath(root);
    if (dirname(resolved) === base && resolved === root)
      await rm(resolved, { recursive: true, force: true });
  }
});
