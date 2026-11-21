import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { AiProviderError } from './errors.ts';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
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

interface ProviderRequest {
  endpoint: string;
  apiKey?: string;
  consent?: boolean;
  signal?: AbortSignal;
}

export async function requestProviderJson(
  options: ProviderRequest,
  route: 'ollama-show' | 'ollama-generate' | 'compatible-completion',
  body: object,
): Promise<unknown> {
  const { url, local } = parseAiEndpoint(options.endpoint, options.consent);
  const base = url.pathname.replace(/\/+$/u, '');
  const routes = {
    'ollama-show': `${base.endsWith('/api') ? base : `${base}/api`}/show`,
    'ollama-generate': `${base.endsWith('/api') ? base : `${base}/api`}/generate`,
    'compatible-completion': `${base || '/v1'}/chat/completions`,
  };
  url.pathname = routes[route];
  const requestBody = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': requestBody.length,
    accept: 'application/json',
  };
  if (options.apiKey) {
    if (!/^[!-~]{1,4096}$/u.test(options.apiKey))
      throw new AiProviderError('Enter a valid AI API key.');
    headers.authorization = `Bearer ${options.apiKey}`;
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = send(
      url,
      {
        method: 'POST',
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
      (response) => {
        const status = response.statusCode ?? 500;
        const declaredLength = Number(response.headers['content-length']);
        const fail = (message: string) => {
          reject(new AiProviderError(message));
          response.destroy();
        };
        response.on('error', () => reject(new AiProviderError('The AI provider disconnected.')));

        if (status >= 300 && status < 400) {
          fail('The AI provider redirected the request. Use its final endpoint URL.');
          return;
        }
        if (status < 200 || status >= 300) {
          fail(`The AI provider returned HTTP ${status}. Check the endpoint, model, and API key.`);
          return;
        }
        if (declaredLength > MAX_RESPONSE_BYTES) {
          fail('The AI provider response exceeded the size limit.');
          return;
        }

        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            fail('The AI provider response exceeded the size limit.');
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch {
            reject(new AiProviderError('The AI provider did not return valid JSON.'));
          }
        });
      },
    );
    request.on('error', (error) => {
      if (error instanceof AiProviderError) reject(error);
      else if (timeout.aborted) reject(new AiProviderError('The AI request timed out.'));
      else if (options.signal?.aborted) reject(new AiProviderError('The AI request was canceled.'));
      else
        reject(
          new AiProviderError(
            'Could not connect to the AI provider. Check that the endpoint is running.',
          ),
        );
    });
    request.end(requestBody);
  });
}
