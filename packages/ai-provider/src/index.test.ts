import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { explainSource, parseAiEndpoint, requestProviderJson } from './index.ts';

const sample = {
  endpoint: 'http://localhost:11434',
  model: 'local-model',
  path: 'src/index.ts',
  content: 'const first = 1\nconst second = 2\nconst third = 3',
};

async function withServer(handler: RequestListener, test: (url: string) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await test(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('source explanations', () => {
  it('enforces endpoint consent before requesting any explanation', async () => {
    const complete = vi.fn().mockResolvedValue('summary');
    await expect(
      explainSource({ complete }, { ...sample, endpoint: 'https://ai.example.com/v1' }),
    ).rejects.toThrow('Explicit consent');
    expect(complete).not.toHaveBeenCalled();
  });

  it('references exactly the lines delivered to the provider', async () => {
    const complete = vi.fn().mockResolvedValue('A short explanation.');
    const result = await explainSource({ complete }, { ...sample, startLine: 2, endLine: 2 });
    expect(result.references).toEqual([{ path: 'src/index.ts', startLine: 2, endLine: 2 }]);
    expect(JSON.parse(complete.mock.calls[0]![0].prompt)).toEqual({
      path: 'src/index.ts',
      startLine: 2,
      endLine: 2,
      source: 'const second = 2',
    });
  });

  it('reports the actual bounded excerpt for a long source file', async () => {
    const complete = vi.fn().mockResolvedValue('summary');
    const content = Array.from({ length: 153 }, () => 'const data = null').join('\n');
    const response = await explainSource({ complete }, { ...sample, content, startLine: 6 });
    expect(response.references[0]?.endLine).toBe(125);
  });
});

describe('provider transport', () => {
  it('accepts loopback and rejects insecure and non-public endpoints', () => {
    expect(parseAiEndpoint('http://localhost:11434').url.hostname).toBe('127.0.0.1');
    expect(parseAiEndpoint('http://[::1]:11434').local).toBe(true);
    expect(() => parseAiEndpoint('http://ai.example.com', true)).toThrow('HTTPS');
    expect(() => parseAiEndpoint('https://10.0.0.1', true)).toThrow('public addresses');
    expect(() => parseAiEndpoint('https://[::ffff:127.0.0.1]', true)).toThrow('public addresses');
    expect(() => parseAiEndpoint('https://key@ai.example.com', true)).toThrow(
      'without credentials',
    );
  });

  it('appends the protocol route and refuses redirects without forwarding credentials', async () => {
    const followed = vi.fn();
    await withServer(
      (request, response) => {
        if (request.url !== '/proxy/v1/chat/completions') {
          followed();
          response.end();
          return;
        }
        expect(request.headers.authorization).toBe('Bearer test-key');
        response.writeHead(302, { location: '/second-target' }).end();
      },
      async (url) => {
        await expect(
          requestProviderJson(
            { endpoint: `${url}/proxy/v1`, apiKey: 'test-key' },
            'compatible-completion',
            {},
          ),
        ).rejects.toThrow('redirected');
        expect(followed).not.toHaveBeenCalled();
      },
    );
  });
});
