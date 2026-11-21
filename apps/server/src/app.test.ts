import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectAnalysis } from '@arqivanta/shared';
import { createApp } from './app.ts';

const exampleRoot = fileURLToPath(new URL('../../../examples/field-notes', import.meta.url));
const host = '127.0.0.1:4317';
const headers = { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' };
let app: ReturnType<typeof createApp> | undefined;

function setup(folderPicker?: Parameters<typeof createApp>[0]['folderPicker']) {
  app = createApp({ database: ':memory:', exampleRoot, folderPicker });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('loopback API', () => {
  it('opens the selected local folder and treats dialog cancellation as a normal response', async () => {
    const pickFolder = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(exampleRoot);
    const api = setup(pickFolder);
    const health = await api.inject({ url: '/api/health', headers });
    expect(health.json()).toMatchObject({ folderPicker: true });

    const pickRequest = {
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { browse: true },
    } as const;
    const foreign = await api.inject({
      ...pickRequest,
      headers: { ...headers, origin: 'https://example.invalid' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(pickFolder).not.toHaveBeenCalled();

    const cancelled = await api.inject(pickRequest);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toBeNull();
    expect((await api.inject({ url: '/api/projects', headers })).json()).toEqual([]);

    const imported = await api.inject(pickRequest);
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json<ProjectAnalysis>()).toMatchObject({
      project: { origin: 'local', name: 'field-notes' },
      entryPoints: expect.arrayContaining([expect.objectContaining({ path: 'src/index.ts' })]),
    });
    expect(pickFolder).toHaveBeenCalledTimes(2);
  });

  it('offers path entry when a native folder picker is unavailable', async () => {
    const api = setup(null);
    const health = await api.inject({ url: '/api/health', headers });
    expect(health.json()).toMatchObject({ folderPicker: false });
    const result = await api.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { browse: true },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().message).toContain('folder path');
  });

  it('analyzes a real local folder and serves matched source and export snapshots', async () => {
    const api = setup();
    const imported = await api.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { path: exampleRoot },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const { project, edges, entryPoints, ...rest } = imported.json<ProjectAnalysis>();
    expect(project.origin).toBe('local');
    expect(rest).not.toHaveProperty('sources');
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'src/index.ts', target: 'src/report/format.ts' }),
    );
    expect(entryPoints).toContainEqual(expect.objectContaining({ path: 'src/index.ts' }));
    const listed = await api.inject({ url: '/api/projects', headers });
    expect(listed.json()).toEqual([project]);

    const source = await api.inject({
      url: `/api/projects/${project.id}/source?path=src/index.ts`,
      headers,
    });
    expect(source.json().content).toContain('createFieldReport');
    const traversal = await api.inject({
      url: `/api/projects/${project.id}/source?path=../package.json`,
      headers,
    });
    expect(traversal.statusCode).toBe(400);

    const json = await api.inject({
      url: `/api/projects/${project.id}/export?format=json`,
      headers,
    });
    expect(json.headers['content-disposition']).toBe(
      'attachment; filename="arqivanta-context.json"',
    );
    expect(json.json()).toMatchObject({
      schemaVersion: 1,
      directories: ['src', 'src/notes', 'src/report'],
      dependencies: edges,
    });
    expect(json.body).not.toContain('createFieldReport');
    expect(json.body).not.toContain(exampleRoot);
    const markdown = await api.inject({
      url: `/api/projects/${project.id}/export?format=markdown`,
      headers,
    });
    expect(markdown.body).toContain('## Verified dependencies');

    const explanation = await api.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/explain`,
      headers,
      payload: {
        path: 'src/index.ts',
        provider: 'openai-compatible',
        endpoint: 'https://example.invalid/v1',
        model: 'example',
      },
    });
    expect(explanation.statusCode).toBe(422);
    expect(explanation.json().message).toMatch(/consent/i);
  });

  it('rejects unexpected hosts, browser origins, non-JSON posts, and invalid project input', async () => {
    const api = setup();
    const badHost = await api.inject({ url: '/api/projects', headers: { host: 'untrusted.test' } });
    expect(badHost.statusCode).toBe(403);
    const crossOrigin = await api.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { host, origin: 'https://untrusted.test' },
      payload: { example: true },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const unsafeNavigation = await api.inject({
      url: '/api/projects',
      headers: { host, 'sec-fetch-site': 'cross-site' },
    });
    expect(unsafeNavigation.statusCode).toBe(403);
    const nonJson = await api.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: 'anything',
    });
    expect(nonJson.statusCode).toBe(415);
    const relative = await api.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { path: '..' },
    });
    expect(relative.statusCode).toBe(400);
    const arbitraryUrl = await api.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { url: 'http://127.0.0.1/admin' },
    });
    expect(arbitraryUrl.statusCode).toBe(400);
  });
});
