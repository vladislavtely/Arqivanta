import { lookup } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { AiProviderError } from './errors.ts';
import type { AiConnectionInput } from './index.ts';

const REQUEST_TIMEOUT_MS = 60_000;
const MODEL_LOOKUP_TIMEOUT_MS = 10_000;
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const nonPublic = new BlockList();
const publicIpv6 = new BlockList();
publicIpv6.addSubnet('2000::', 3, 'ipv6');

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  nonPublic.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  nonPublic.addSubnet(network, prefix, 'ipv6');
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, 'ipv4');
  return family === 6 && publicIpv6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6');
}

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

const lookupPublicAddress: LookupFunction = (host, options, callback) => {
  lookup(host, { all: true, order: 'verbatim' }, (error, addresses) => {
    if (error) {
      callback(error, '');
      return;
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      callback(new AiProviderError('Remote AI endpoints must resolve to public addresses.'), '');
      return;
    }
    const first = addresses[0]!;
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

export function parseAiEndpoint(endpoint: string, consent?: boolean): { url: URL; local: boolean } {
  let url: URL;
  try {
    if (endpoint.length > 2_048 || /[\s\\]/u.test(endpoint)) throw new Error();
    url = new URL(endpoint);
  } catch {
    throw new AiProviderError('Enter a valid AI endpoint URL.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new AiProviderError('Enter an AI endpoint without credentials, a query, or a fragment.');
  }

  const local = localHosts.has(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new AiProviderError(
      'Remote AI endpoints must use HTTPS. HTTP is available on loopback only.',
    );
  }
  if (!local && consent !== true) {
    throw new AiProviderError(
      'Explicit consent is required before sending source to a remote AI endpoint.',
    );
  }
  const address = url.hostname.replace(/^\[|\]$/gu, '');
  if (!local && isIP(address) && !isPublicAddress(address)) {
    throw new AiProviderError('Remote AI endpoints must use public addresses.');
  }
  if (url.hostname === 'localhost' && url.protocol === 'http:') url.hostname = '127.0.0.1';
  return { url, local };
}

type GenerationRoute = 'ollama-generate' | 'compatible-completion';
type ModelListRoute = 'ollama-tags' | 'compatible-models';
type ProviderRoute = GenerationRoute | ModelListRoute | 'ollama-show';
type ResponseFormat = 'application/json' | 'application/x-ndjson' | 'text/event-stream';

class ProviderStatusError extends AiProviderError {
  readonly status: number;

  constructor(status: number) {
    super(`The AI provider returned HTTP ${status}. Check the endpoint, model, and API key.`);
    this.status = status;
  }
}

export async function* requestProviderBody(
  options: AiConnectionInput,
  route: ProviderRoute,
  format: ResponseFormat,
  body?: object,
): AsyncGenerator<Buffer> {
  const { url, local } = parseAiEndpoint(options.endpoint, options.consent);
  const base = url.pathname.replace(/\/+$/u, '');
  const ollamaBase = base.endsWith('/api') ? base : `${base}/api`;
  const compatibleBase = base || '/v1';
  const routes = {
    'ollama-tags': `${ollamaBase}/tags`,
    'ollama-show': `${ollamaBase}/show`,
    'ollama-generate': `${ollamaBase}/generate`,
    'compatible-models': `${compatibleBase}/models`,
    'compatible-completion': `${compatibleBase}/chat/completions`,
  };
  url.pathname = routes[route];
  const requestBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {
    accept: format,
    'accept-encoding': 'identity',
  };
  if (requestBody) {
    if (requestBody.length > MAX_MESSAGE_BYTES) {
      throw new AiProviderError('The AI request exceeded the size limit.');
    }
    headers['content-type'] = 'application/json';
    headers['content-length'] = requestBody.length;
  }
  if (options.apiKey) {
    if (!/^[!-~]{1,4096}$/u.test(options.apiKey))
      throw new AiProviderError('Enter a valid AI API key.');
    headers.authorization = `Bearer ${options.apiKey}`;
  }

  const isGeneration = route === 'ollama-generate' || route === 'compatible-completion';
  const streaming = format !== 'application/json';
  const deadline = new AbortController();
  const timeout = streaming
    ? STREAM_IDLE_TIMEOUT_MS
    : isGeneration
      ? REQUEST_TIMEOUT_MS
      : MODEL_LOOKUP_TIMEOUT_MS;
  const timer = setTimeout(() => deadline.abort(), timeout).unref();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  let response: IncomingMessage | undefined;
  let bytes = 0;

  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = send(
        url,
        {
          method: requestBody ? 'POST' : 'GET',
          headers,
          signal,
          agent: false,
          ...(local
            ? {
                lookup: (_host, lookupOptions, callback) => {
                  if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
                  else callback(null, '127.0.0.1', 4);
                },
              }
            : { lookup: lookupPublicAddress }),
        },
        (incoming) => {
          incoming.on('error', reject);
          resolve(incoming);
        },
      );
      request.on('error', reject);
      request.end(requestBody);
    });
    const status = response.statusCode ?? 500;
    if (status >= 300 && status < 400) {
      throw new AiProviderError(
        'The AI provider redirected the request. Use its final endpoint URL.',
      );
    }
    if (status < 200 || status >= 300) throw new ProviderStatusError(status);

    const sizeError = 'The AI provider response exceeded the size limit.';
    if (Number(response.headers['content-length']) > MAX_MESSAGE_BYTES) {
      throw new AiProviderError(sizeError);
    }
    for await (const chunk of response as AsyncIterable<Buffer>) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) throw new AiProviderError(sizeError);
      if (streaming) timer.refresh();
      yield chunk;
    }
    signal.throwIfAborted();
  } catch (error) {
    if (options.signal?.aborted) throw new AiProviderError('The AI request was canceled.');
    if (deadline.signal.aborted) {
      if (!streaming) throw new AiProviderError('The AI request timed out.');
      throw new AiProviderError(
        bytes
          ? 'The AI provider stopped sending data for 2 minutes.'
          : 'The AI provider sent no response data for 2 minutes. Try a smaller context window.',
      );
    }
    if (error instanceof AiProviderError) throw error;
    if (response) throw new AiProviderError('The AI provider disconnected.');
    throw new AiProviderError(
      'Could not connect to the AI provider. Check that the endpoint is running.',
    );
  } finally {
    clearTimeout(timer);
    response?.destroy();
  }
}

async function readJson(
  options: AiConnectionInput,
  route: ProviderRoute,
  body?: object,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of requestProviderBody(options, route, 'application/json', body)) {
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AiProviderError('The AI provider did not return valid JSON.');
  }
}

export function requestProviderJson(
  options: AiConnectionInput,
  route: GenerationRoute | 'ollama-show',
  body: object,
): Promise<unknown> {
  return readJson(options, route, body);
}

export async function requestProviderModelList(
  options: AiConnectionInput,
  route: ModelListRoute,
): Promise<Record<string, unknown> | null> {
  try {
    const data = await readJson(options, route);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new AiProviderError('The AI provider did not return a valid model list.');
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProviderStatusError && [404, 405, 501].includes(error.status)) return null;
    throw error;
  }
}
