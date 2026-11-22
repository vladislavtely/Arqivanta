import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type {
  RepositoryContext,
  RepositoryContextExcerpt,
} from '../../packages/shared/src/index.ts';

function modelDelta(response: ServerResponse, text: string) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
}

test('previews evidence, streams and stops chat, and opens verified inline source ranges', async ({
  page,
}) => {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  let generation: ServerResponse | undefined;
  let stopped = false;
  let discoveryCount = 0;
  const model = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      discoveryCount++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    request.setEncoding('utf8');
    let body = '';
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      requests.push(JSON.parse(body));
      generation = response;
      response.setHeader('Content-Type', 'text/event-stream');
      if (requests.length === 1) modelDelta(response, 'The entry point builds the report ');
      else {
        modelDelta(response, 'A second response is in progress.');
        response.once('close', () => (stopped = true));
      }
    });
  });
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
  try {
    const { port } = model.address() as AddressInfo;
    await page.goto('/');
    await page.getByRole('button', { name: 'Open example' }).click();
    await expect(page.getByRole('heading', { name: 'Repository Explorer' })).toBeVisible();
    const assistant = page.getByRole('button', { name: 'Repository AI Assistant', exact: true });
    await assistant.click();
    await page.getByRole('checkbox', { name: 'Enable AI assistant' }).check();
    await page.getByLabel('Provider', { exact: true }).selectOption('openai-compatible');
    await page.getByLabel('Endpoint', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
    await page.getByRole('button', { name: 'Discover models' }).click();
    await page.getByLabel('Discovered models').selectOption('fixture-model');
    await expect(page.getByLabel('Model name')).toHaveValue('fixture-model');
    expect(discoveryCount).toBe(1);
    expect(requests).toHaveLength(0);

    const question = page.getByRole('textbox', { name: 'Repository question' });
    await question.fill('Where is createFieldReport defined and which files does it import?');
    const [preview] = await Promise.all([
      page.waitForResponse('**/api/projects/*/ai-context'),
      page.getByRole('button', { name: 'Preview context' }).click(),
    ]);
    expect(preview.ok()).toBe(true);
    const context = (await preview.json()) as RepositoryContext;
    const excerpt = context.excerpts.find(
      ({ path, source }) =>
        path === 'src/index.ts' && source.includes('function createFieldReport'),
    );
    const helper = context.excerpts.find(({ path }) => path === 'src/report/format.ts');
    expect(excerpt).toBeDefined();
    expect(helper).toBeDefined();
    expect(requests).toHaveLength(0);

    const send = page.getByRole('button', { name: 'Send question' });
    const stop = page.getByRole('button', { name: 'Stop response' });
    await send.click();
    await expect(
      page.getByText('The entry point builds the report', { exact: true }),
    ).toBeVisible();
    await expect(stop).toBeEnabled();
    const received = requests[0]!.messages;
    expect(received[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('untrusted data'),
    });
    expect(received[1]!.role).toBe('user');
    const prompt = JSON.parse(received[1]!.content) as { excerpts: RepositoryContextExcerpt[] };
    expect(prompt.excerpts).toEqual(context.excerpts);
    modelDelta(
      generation!,
      `[${excerpt!.id}]. The formatter renders each note [${helper!.id}]. [S9999]`,
    );
    generation!.end('data: [DONE]\n\n');

    const reportLabel = `src/index.ts:${excerpt!.startLine}–${excerpt!.endLine}`;
    const formatLabel = `src/report/format.ts:${helper!.startLine}${helper!.startLine === helper!.endLine ? '' : `–${helper!.endLine}`}`;
    const answer = page.getByRole('region', { name: 'Assistant response' });
    const citation = answer.getByRole('button', { name: reportLabel, exact: true });
    await expect(answer.locator('p.assistant-answer-text')).toHaveText(
      `The entry point builds the report ${reportLabel}. The formatter renders each note ${formatLabel}.`,
    );
    await expect(answer.getByRole('button', { name: formatLabel, exact: true })).toBeVisible();
    await expect(page.getByText(/S9999/)).toHaveCount(0);
    await citation.click();
    const source = page.getByRole('region', { name: 'Source code' });
    await expect(source).toContainText('createFieldReport');
    const highlighted = source.locator('.code-line.active');
    await expect(highlighted).toHaveCount(excerpt!.endLine - excerpt!.startLine + 1);
    await expect(highlighted.first()).toHaveAttribute('data-line', String(excerpt!.startLine));
    await expect(highlighted.last()).toHaveAttribute('data-line', String(excerpt!.endLine));

    await assistant.click();
    await expect(page.getByText(/The entry point builds the report/)).toBeVisible();
    await question.fill('What dependencies does createFieldReport use?');
    await send.click();
    await expect(
      page.getByText('A second response is in progress.', { exact: true }),
    ).toBeVisible();
    await stop.click();
    await expect.poll(() => stopped).toBe(true);
    await expect(stop).toHaveCount(0);

    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByLabel('Project folder').fill(resolve('examples/python-tasks'));
    await page.getByRole('button', { name: 'Analyze folder' }).click();
    await expect(source).toContainText('def main()');
    await assistant.click();
    await expect(page.getByText(/The entry point builds the report/)).toHaveCount(0);
    await expect(question).toBeEmpty();
  } finally {
    const closed = new Promise<void>((done) => model.close(() => done()));
    model.closeAllConnections();
    await closed;
  }
});
