import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

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
