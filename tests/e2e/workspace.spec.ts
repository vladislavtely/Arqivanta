import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('keeps large file lists and graphs bounded while searching every file', async ({ page }) => {
  const temporary = await realpath(tmpdir());
  const root = await mkdtemp(join(temporary, 'arqivanta-large-browser-test-'));
  try {
    for (let start = 0; start < 510; start += 50) {
      const writes = [];
      for (let index = start; index < Math.min(start + 50, 510); index++) {
        const name = `file-${String(index).padStart(4, '0')}.ts`;
        writes.push(writeFile(join(root, name), `export const value = ${index};\n`));
      }
      await Promise.all(writes);
    }
    await page.goto('/');
    await page.getByLabel('Project folder').fill(root);
    await page.getByRole('button', { name: 'Analyze folder' }).click();
    await expect(page.getByText('Page 1 of 3', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next file page' }).click();
    await expect(page.getByText('Page 2 of 3', { exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Find files or symbols' }).fill('file-0509');
    await expect(page.getByRole('button', { name: 'file-0509.ts', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Architecture Map' }).click();
    const scope = page.getByLabel('Filter architecture map');
    await expect(scope).toHaveValue('folders');
    await expect(page.getByRole('region', { name: 'Repository dependency graph' })).toContainText(
      'Repository root',
    );
    await scope.selectOption('all');
    await expect(page.getByText(/350 of 510 files/)).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search graph files' }).fill('file-0509');
    await expect(
      page
        .getByRole('region', { name: 'Repository dependency graph' })
        .getByText('file-0509.ts', { exact: true }),
    ).toBeVisible();
  } finally {
    const resolved = await realpath(root);
    if (dirname(resolved) === temporary && resolved === root) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
});

test('opens a folder graph, moves and resets a node, and highlights both import directions', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open example' }).click();
  await page.getByRole('button', { name: 'Architecture Map' }).click();
  const scope = page.getByLabel('Filter architecture map');
  await scope.selectOption('folders');
  const graph = page.getByRole('region', { name: 'Repository dependency graph' });
  const notes = graph.locator('[data-id="folder:src/notes"]');
  await expect(notes).toBeVisible();
  const initialPosition = await notes.evaluate(
    (element) => (element as HTMLElement).style.transform,
  );
  const box = (await notes.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 78, box.y + box.height / 2 + 65, { steps: 8 });
  await page.mouse.up();
  const reset = page.getByRole('button', { name: 'Reset layout' });
  await expect(reset).toBeEnabled();
  await expect
    .poll(() => notes.evaluate((element) => (element as HTMLElement).style.transform))
    .not.toBe(initialPosition);
  await reset.click();
  await expect(reset).toBeDisabled();
  await expect
    .poll(() => notes.evaluate((element) => (element as HTMLElement).style.transform))
    .toBe(initialPosition);

  await notes.click();
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(scope).toHaveValue('folder');
  await expect(graph.getByText('timeline.ts', { exact: true })).toBeVisible();
  await expect(graph.getByText('format.ts', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to folders' }).click();
  await expect(scope).toHaveValue('folders');

  await scope.selectOption('all');
  await graph.getByText('format.ts', { exact: true }).click();
  await page.getByRole('button', { name: 'Focus on file' }).click();
  await expect(scope).toHaveValue('selected');
  const paths = graph.locator('.react-flow__edge-path');
  await expect(paths).toHaveCount(3);
  const strokes = await paths.evaluateAll((edges) =>
    edges.map((edge) => getComputedStyle(edge).stroke),
  );
  expect(strokes).toEqual(expect.arrayContaining(['rgb(110, 220, 230)', 'rgb(255, 196, 124)']));
});

test('opens a Python project and focuses the graph on the selected file', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Project folder').fill(resolve('examples/python-tasks'));
  await page.getByRole('button', { name: 'Analyze folder' }).click();
  await expect(page.getByRole('region', { name: 'Source code' })).toContainText('def main()');

  await page.getByRole('button', { name: 'Architecture Map' }).click();
  await page.getByLabel('Filter architecture map').selectOption('selected');
  const graph = page.getByRole('region', { name: 'Repository dependency graph' });
  await expect(graph.getByText('__main__.py', { exact: true })).toBeVisible();
  await expect(graph.getByText('formatting.py', { exact: true })).toBeVisible();
  await expect(graph.getByText('models.py', { exact: true })).toHaveCount(0);
});

test('opens a project through Browse folders without typing a path', async ({ page }) => {
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { status: 'ok', folderPicker: true } }),
  );
  let cancelled = false;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    expect(route.request().postDataJSON()).toEqual({ browse: true });
    if (!cancelled) {
      cancelled = true;
      return route.fulfill({ contentType: 'application/json', body: 'null' });
    }
    // Simulate the native dialog returning the sample's path, then run real analysis.
    const response = await route.fetch({ postData: { path: resolve('examples/field-notes') } });
    await route.fulfill({ response });
  });

  await page.goto('/');
  const browse = page.getByRole('button', { name: 'Browse folders' });
  await expect(page.getByLabel('Project folder')).toBeEmpty();
  await browse.click();
  await expect(browse).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await browse.click();
  await expect(page.getByRole('heading', { name: 'Repository Explorer' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Source code' })).toContainText(
    'createFieldReport',
  );
});

test('explores a local repository, follows a graph node and downloads verified context', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Project folder').fill(resolve('examples/field-notes'));
  await page.getByRole('button', { name: 'Analyze folder' }).click();
  await expect(page.getByRole('heading', { name: 'Repository Explorer' })).toBeVisible();
  await page.getByRole('button', { name: 'src/index.ts', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Source code' })).toContainText(
    'createFieldReport',
  );

  await page.getByRole('button', { name: 'Architecture Map', exact: true }).click();
  const graph = page.getByRole('region', { name: 'Repository dependency graph' });
  await expect(graph).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search graph files' }).fill('format.ts');
  await graph.getByText('format.ts', { exact: true }).click();
  await page.getByRole('button', { name: 'Open in Explorer' }).click();
  await expect(page.getByRole('region', { name: 'Source code' })).toContainText(
    'export function formatNote',
  );

  await page.getByRole('button', { name: 'Export Center', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download JSON' }).click(),
  ]);
  const document = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(document.dependencies).toContainEqual(
    expect.objectContaining({ source: 'src/index.ts', target: 'src/report/format.ts' }),
  );
});

test('opens the bundled example on a narrow viewport without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open example' }).click();
  await expect(page.getByRole('heading', { name: 'Repository Explorer' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Source code' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('keeps AI off by default and requires consent for an external explanation', async ({
  page,
}) => {
  await page.route('**/api/projects/*/explain', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      path: 'src/index.ts',
      consent: true,
      startLine: 1,
      endLine: 3,
    });
    await route.fulfill({
      json: {
        text: 'The entry point imports its helpers.',
        references: [{ path: 'src/index.ts', startLine: 1, endLine: 3 }],
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open example' }).click();
  await expect(page.getByRole('heading', { name: 'Repository Explorer' })).toBeVisible();
  await page.getByRole('button', { name: 'AI Explanations', exact: true }).click();
  const enableAI = page.getByRole('checkbox', { name: 'Enable AI explanations' });
  await expect(enableAI).not.toBeChecked();
  await enableAI.check();
  await page.getByLabel('Endpoint').fill('https://example.invalid/v1');
  await page.getByLabel('Model name').fill('example');
  await page.getByLabel('Start line').fill('1');
  await page.getByLabel('End line').fill('3');
  const generate = page.getByRole('button', { name: 'Generate explanation' });
  await expect(generate).toBeDisabled();
  await page.getByRole('checkbox', { name: /I consent/i }).check();
  await generate.click();
  await expect(page.getByText('The entry point imports its helpers.')).toBeVisible();
  await page.getByRole('button', { name: 'src/index.ts:1–3' }).click();
  await expect(page.getByRole('region', { name: 'Source code' })).toContainText(
    'createFieldReport',
  );
});
