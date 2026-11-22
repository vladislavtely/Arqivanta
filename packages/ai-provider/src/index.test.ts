import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  explainSource,
  parseAiEndpoint,
  requestProviderEvents,
  requestProviderJson,
  requestProviderModelList,
} from './index.ts';

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
    server.closeAllConnections();
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

  it('matches the analyzer’s language-specific line separators', async () => {
    const complete = vi.fn().mockResolvedValue('summary');
    const content = 'first\u2028second\u2029third\r\nfourth';
    await explainSource({ complete }, { ...sample, content, startLine: 3, endLine: 3 });
    await explainSource(
      { complete },
      {
        ...sample,
        path: 'sample.py',
        content,
        startLine: 2,
        endLine: 2,
      },
    );
    expect(JSON.parse(complete.mock.calls[0]![0].prompt).source).toBe('third');
    expect(JSON.parse(complete.mock.calls[1]![0].prompt).source).toBe('fourth');
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

  it('discovers models with a bodyless GET and distinguishes unsupported discovery', async () => {
    const requests: { method?: string; url?: string; auth?: string; body: string }[] = [];
    await withServer(
      async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
        requests.push({
          method: request.method,
          url: request.url,
          auth: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (request.url === '/v1/models') response.writeHead(405).end();
        else response.end('{"models":[]}');
      },
      async (endpoint) => {
        await expect(
          requestProviderModelList({ endpoint, apiKey: 'test-key' }, 'ollama-tags'),
        ).resolves.toEqual({ models: [] });
        await expect(
          requestProviderModelList({ endpoint }, 'compatible-models'),
        ).resolves.toBeNull();
        expect(requests).toEqual([
          { method: 'GET', url: '/api/tags', auth: 'Bearer test-key', body: '' },
          { method: 'GET', url: '/v1/models', auth: undefined, body: '' },
        ]);
      },
    );
  });

  it('decodes incremental SSE across UTF-8 and CRLF boundaries', async () => {
    let finishResponse: () => void;
    const firstEvent = Buffer.from(': comment\r\ndata: {"text":"café"}\r\n\r\n');
    const middle = firstEvent.indexOf(Buffer.from('é')) + 1;
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(firstEvent.subarray(0, middle));
        setImmediate(() => {
          response.write(firstEvent.subarray(middle, firstEvent.length - 1));
          response.write(firstEvent.subarray(firstEvent.length - 1));
        });
        finishResponse = () => response.end('data: [DONE]\r\n\r\n');
      },
      async (endpoint) => {
        const events = requestProviderEvents({ endpoint }, 'compatible-completion', {});
        await expect(events.next()).resolves.toMatchObject({
          value: { done: false, data: { text: 'café' } },
        });
        finishResponse();
        await expect(events.next()).resolves.toMatchObject({ value: { done: true } });
        await expect(events.next()).resolves.toMatchObject({ done: true });
      },
    );
  });

  it('sanitizes NDJSON stream errors after yielding earlier chunks', async () => {
    await withServer(
      (_request, response) => {
        response.end('{"response":"ok"}\n{"error":"private upstream detail"}\n');
      },
      async (endpoint) => {
        const events = requestProviderEvents({ endpoint }, 'ollama-generate', {});
        await expect(events.next()).resolves.toMatchObject({
          value: { done: false, data: { response: 'ok' } },
        });
        await expect(events.next()).rejects.toThrow(
          /^The AI provider reported an error during generation\.$/u,
        );
      },
    );
  });

  it('cancels a response that stalls after its first streaming chunk', async () => {
    await withServer(
      (_request, response) => response.write('{"response":"ok"}\n'),
      async (endpoint) => {
        const controller = new AbortController();
        const events = requestProviderEvents(
          { endpoint, signal: controller.signal },
          'ollama-generate',
          {},
        );
        await expect(events.next()).resolves.toMatchObject({
          value: { done: false, data: { response: 'ok' } },
        });
        const pending = events.next();
        controller.abort();
        await expect(pending).rejects.toThrow('The AI request was canceled.');
      },
    );
  });

  it('continues a slow stream as long as response data keeps arriving', async () => {
    let send: (answer: string) => void;
    let finish: () => void;
    await withServer(
      (_request, response) => {
        send = (answer) => {
          response.write(`${JSON.stringify({ response: answer })}\n`);
        };
        finish = () => response.end('{"done":true}\n');
        send('first');
      },
      async (endpoint) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const events = requestProviderEvents({ endpoint }, 'ollama-generate', {});
          await expect(events.next()).resolves.toMatchObject({
            value: { data: { response: 'first' } },
          });
          for (const text of ['second', 'third']) {
            vi.advanceTimersByTime(90_000);
            send(text);
            await expect(events.next()).resolves.toMatchObject({
              value: { data: { response: text } },
            });
          }
          finish();
          await expect(events.next()).resolves.toMatchObject({ value: { data: { done: true } } });
          await expect(events.next()).resolves.toMatchObject({ done: true });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  it('reports a provider stall if no more data arrives after a partial answer', async () => {
    await withServer(
      (_request, response) => response.write('{"response":"first"}\n'),
      async (endpoint) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const events = requestProviderEvents({ endpoint }, 'ollama-generate', {});
          await expect(events.next()).resolves.toMatchObject({
            value: { data: { response: 'first' } },
          });
          const stalled = expect(events.next()).rejects.toThrow(
            'stopped sending data for 2 minutes',
          );
          vi.advanceTimersByTime(120_000);
          await stalled;
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  it('bounds the size of a streaming message before parsing it', async () => {
    await withServer(
      (_request, response) => response.end('x'.repeat(512 * 1024 + 1)),
      async (endpoint) => {
        const events = requestProviderEvents({ endpoint }, 'ollama-generate', {});
        await expect(events.next()).rejects.toThrow('stream message exceeded the size limit');
      },
    );
  });
});
