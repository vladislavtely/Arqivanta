import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, parse } from 'node:path';
import { Worker } from 'node:worker_threads';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { AiProviderError, explainSource } from '@arqivanta/ai-provider';
import { exportContext, openProjectStore } from '@arqivanta/core';
import {
  GitHubImportError,
  parseGitHubUrl,
  resolveGitHubRevision,
  withGitHubSnapshot,
} from '@arqivanta/github-import';
import { ollamaProvider } from '@arqivanta/provider-ollama';
import { openAiCompatibleProvider } from '@arqivanta/provider-openai-compatible';
import type { AnalysisResult } from '@arqivanta/shared';
import { pickWindowsFolder } from './windows-folder-picker.ts';

interface ServerOptions {
  database: string;
  exampleRoot: string;
  webRoot?: string;
  apiPort?: number;
  folderPicker?: typeof pickWindowsFolder | null;
}

class RequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function analyze(root: string): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis-worker.ts', import.meta.url), {
      workerData: root,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 224, stackSizeMb: 4 },
    });
    const timer = setTimeout(() => {
      reject(new RequestError(422, 'Analysis exceeded 25 seconds. Try opening a smaller folder.'));
      void worker.terminate();
    }, 25_000);
    worker.once('message', ({ result }: { result?: AnalysisResult }) => {
      clearTimeout(timer);
      if (result) resolve(result);
      else
        reject(new RequestError(422, 'The folder could not be analyzed. Check read permissions.'));
      void worker.terminate();
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new RequestError(422, 'Analysis could not finish within its resource limits.'));
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new RequestError(422, 'The analysis worker exited before returning a snapshot.'));
    });
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'Provide a JSON object.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new RequestError(400, `Provide a valid ${field}.`);
  }
  return value;
}

function line(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new RequestError(400, 'Line numbers must be positive integers.');
  }
  return value;
}

function sourcePath(value: unknown) {
  const path = text(value, 'source path', 4096);
  if (
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new RequestError(400, 'Use a path relative to the selected project.');
  }
  return path;
}

async function localRoot(input: unknown) {
  const path = text(input, 'absolute project folder path', 4096);
  if (!isAbsolute(path) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(path))) {
    throw new RequestError(400, 'Enter an absolute path to a local folder.');
  }
  const target = await realpath(path).catch(() => undefined);
  if (
    !target ||
    target === parse(target).root ||
    (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(target)) ||
    !(await stat(target).catch(() => undefined))?.isDirectory()
  ) {
    throw new RequestError(400, 'Choose a readable project folder within a local drive.');
  }
  return target;
}

export function createApp({
  database,
  exampleRoot,
  webRoot,
  apiPort = 4317,
  folderPicker = process.platform === 'win32' ? pickWindowsFolder : null,
}: ServerOptions) {
  const app = Fastify({ bodyLimit: 16_384, requestTimeout: 15_000 });
  const store = openProjectStore(database);
  const allowedHosts = new Set([`127.0.0.1:${apiPort}`, '127.0.0.1:5173']);
  const folderPickerShutdown = new AbortController();
  let importing = false;
  let explaining = false;

  app.addHook('preClose', async () => folderPickerShutdown.abort());
  app.addHook('onClose', async () => store.close());
  app.addHook('onRequest', async (request, reply) => {
    const { host, origin, 'sec-fetch-site': fetchSite } = request.headers;
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'",
    );
    if (!host || !allowedHosts.has(host))
      throw new RequestError(403, 'Use the Arqivanta loopback address.');
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (
        (origin !== undefined && origin !== `http://${host}`) ||
        (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')
      ) {
        throw new RequestError(403, 'This origin cannot access the local API.');
      }
      if (
        request.method === 'POST' &&
        request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
      ) {
        throw new RequestError(415, 'Send an application/json request.');
      }
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof RequestError)
      return reply.code(error.statusCode).send({ message: error.message });
    if (error instanceof GitHubImportError) {
      const status = {
        'invalid-url': 400,
        'not-found': 404,
        'rate-limit': 429,
        'too-large': 413,
        'invalid-archive': 422,
        unavailable: 502,
        canceled: 504,
      }[error.code];
      return reply.code(status ?? 502).send({ message: error.message });
    }
    if (error instanceof AiProviderError) return reply.code(422).send({ message: error.message });
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ message: 'The request could not be read.' });
    }
    return reply.code(500).send({ message: 'The local request could not be completed.' });
  });

  function getProject(id: string) {
    const project = store.get(id);
    if (!project) throw new RequestError(404, 'This project is no longer in the local cache.');
    return project;
  }

  function getSource(id: string, path: string) {
    const content = store.source(id, path);
    if (content === undefined)
      throw new RequestError(404, 'This file is unavailable in the analyzed snapshot.');
    return content;
  }

  app.get('/api/health', async () => ({ status: 'ok', folderPicker: folderPicker !== null }));
  app.get('/api/projects', async () => store.list());
  app.post('/api/projects', async (request, reply) => {
    const body = record(request.body);
    if (Object.keys(body).length !== 1) {
      throw new RequestError(400, 'Choose one project source.');
    }
    if (importing) throw new RequestError(409, 'Wait for the current import to finish.');
    importing = true;
    try {
      if (body.example === true) {
        const key = 'example:field-notes:v1';
        return (
          store.cached(key) ??
          store.save({ name: 'Field Notes', origin: 'example' }, await analyze(exampleRoot), key)
        );
      }
      if (body.browse === true || Object.hasOwn(body, 'path')) {
        let selectedPath = body.path;
        if (body.browse === true) {
          if (!folderPicker) {
            throw new RequestError(400, 'Enter a folder path on this platform.');
          }
          const client = new AbortController();
          const cancel = () => client.abort();
          const signal = AbortSignal.any([client.signal, folderPickerShutdown.signal]);
          reply.raw.once('close', cancel);
          try {
            selectedPath = await folderPicker(signal);
            if (selectedPath === null || signal.aborted) return null;
          } catch {
            if (signal.aborted) return null;
            throw new RequestError(
              503,
              'The Windows folder picker could not finish. Enter a folder path to continue.',
            );
          } finally {
            reply.raw.off('close', cancel);
          }
        }
        const root = await localRoot(selectedPath);
        return store.save({ name: basename(root), origin: 'local' }, await analyze(root));
      }
      if (Object.hasOwn(body, 'url')) {
        const input = text(body.url, 'public GitHub repository URL', 2048);
        const repo = parseGitHubUrl(input);
        const deadline = AbortSignal.timeout(90_000);
        const commitSha = await resolveGitHubRevision(repo, deadline);
        const cacheKey = `github:v2:${repo.url.toLowerCase()}:${commitSha}`;
        return (
          store.cached(cacheKey) ??
          (await withGitHubSnapshot(
            repo,
            commitSha,
            async (root) => {
              const analysis = await analyze(root);
              if (deadline.aborted)
                throw new RequestError(504, 'GitHub import timed out. Try a smaller repository.');
              return store.save(
                {
                  name: `${repo.owner}/${repo.repo}`,
                  origin: 'github',
                  commitSha,
                  repositoryUrl: repo.url,
                },
                analysis,
                cacheKey,
              );
            },
            deadline,
          ))
        );
      }
      throw new RequestError(
        400,
        'Choose a local folder, the example, or a public GitHub repository.',
      );
    } finally {
      importing = false;
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async ({ params }) =>
    getProject(params.id),
  );
  app.get<{ Params: { id: string }; Querystring: { path?: unknown } }>(
    '/api/projects/:id/source',
    async ({ params, query }) => {
      const path = sourcePath(query.path);
      return { path, content: getSource(params.id, path) };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { format?: unknown } }>(
    '/api/projects/:id/export',
    async ({ params, query }, reply) => {
      const { format } = query;
      if (format !== 'markdown' && format !== 'json')
        throw new RequestError(400, 'Choose Markdown or JSON.');
      const suffix = format === 'json' ? 'json' : 'md';
      reply.header('Content-Disposition', `attachment; filename="arqivanta-context.${suffix}"`);
      reply.type(
        format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      );
      return reply.send(exportContext(getProject(params.id), format));
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/explain',
    async ({ params, body: input }, reply) => {
      const body = record(input);
      const provider =
        body.provider === 'ollama'
          ? ollamaProvider
          : body.provider === 'openai-compatible'
            ? openAiCompatibleProvider
            : undefined;
      if (!provider) throw new RequestError(400, 'Choose a supported AI provider.');
      if (body.consent !== undefined && typeof body.consent !== 'boolean')
        throw new RequestError(400, 'Provide valid consent.');
      const path = sourcePath(body.path);
      const endpoint = text(body.endpoint, 'provider endpoint', 2048);
      const model = text(body.model, 'model name', 200);
      const apiKey =
        body.apiKey === undefined || body.apiKey === ''
          ? undefined
          : text(body.apiKey, 'API key', 4096);
      const startLine = line(body.startLine);
      const endLine = line(body.endLine);
      if (explaining) throw new RequestError(409, 'Wait for the current explanation to finish.');
      const content = getSource(params.id, path);
      const client = new AbortController();
      const cancel = () => client.abort();
      const signal = AbortSignal.any([client.signal, AbortSignal.timeout(60_000)]);
      reply.raw.once('close', cancel);
      explaining = true;
      try {
        return await explainSource(provider, {
          path,
          content,
          endpoint,
          model,
          apiKey,
          consent: body.consent,
          startLine,
          endLine,
          signal,
        });
      } finally {
        reply.raw.off('close', cancel);
        explaining = false;
      }
    },
  );

  if (webRoot)
    app.register(fastifyStatic, { root: webRoot, index: 'index.html', dotfiles: 'deny' });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ message: 'This address is unavailable.' }),
  );
  return app;
}
