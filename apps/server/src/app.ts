import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, parse } from 'node:path';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply } from 'fastify';
import { AiProviderError, explainSource, parseAiEndpoint } from '@arqivanta/ai-provider';
import {
  exportContext,
  buildCodeTrace,
  compareSnapshots,
  hasSensitiveAiSource,
  isSensitiveAiPath,
  openProjectStore,
  reviewSavedTrace,
  traceFingerprints,
} from '@arqivanta/core';
import {
  GitHubImportError,
  parseGitHubUrl,
  resolveGitHubRevision,
  withGitHubSnapshot,
} from '@arqivanta/github-import';
import { ollamaProvider } from '@arqivanta/provider-ollama';
import { openAiCompatibleProvider } from '@arqivanta/provider-openai-compatible';
import {
  repositoryAiLimits,
  type AnalysisResult,
  type FlowAnchor,
  type ProjectAnalysis,
  type RepositoryStreamEvent,
} from '@arqivanta/shared';
import { answerRepositoryQuestion, prepareRepositoryQuestion } from './repository-assistant.ts';
import { GitBaselineError, readGitHead } from './git-baseline.ts';
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

function analyze(root: string, previous?: ProjectAnalysis): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis-worker.ts', import.meta.url), {
      workerData: {
        root,
        baseline: previous && { files: previous.files, parseVersion: previous.parseVersion },
      },
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

function flowAnchor(body: Record<string, unknown>): FlowAnchor {
  return { path: sourcePath(body.path), key: text(body.key, 'route or function', 512) };
}

function requireAiEnabled(body: Record<string, unknown>) {
  if (body.enabled !== true) throw new RequestError(403, 'Enable the AI assistant first.');
}

function aiConnection(body: Record<string, unknown>) {
  const provider =
    body.provider === 'ollama'
      ? ollamaProvider
      : body.provider === 'openai-compatible'
        ? openAiCompatibleProvider
        : undefined;
  if (!provider) throw new RequestError(400, 'Choose a supported AI provider.');
  const consent = body.consent;
  if (consent !== undefined && typeof consent !== 'boolean') {
    throw new RequestError(400, 'Provide valid consent.');
  }
  const endpoint = text(body.endpoint, 'provider endpoint', 2048);
  const { local } = parseAiEndpoint(endpoint, consent);
  const apiKey =
    body.apiKey === undefined || body.apiKey === ''
      ? undefined
      : text(body.apiKey, 'API key', 4096);
  return { provider, connection: { endpoint, apiKey, consent }, local };
}

function repositoryQuestion(body: Record<string, unknown>) {
  const { minContextWindow, maxContextWindow, maxQuestionLength, maxPriorQuestions } =
    repositoryAiLimits;
  const contextWindow = body.contextWindow ?? repositoryAiLimits.defaultContextWindow;
  if (
    typeof contextWindow !== 'number' ||
    !Number.isInteger(contextWindow) ||
    contextWindow < minContextWindow ||
    contextWindow > maxContextWindow
  ) {
    throw new RequestError(
      400,
      `Choose a context window from ${minContextWindow} to ${maxContextWindow} tokens.`,
    );
  }
  const question = text(body.question, 'repository question', maxQuestionLength).trim();
  const history = body.priorQuestions ?? [];
  if (!Array.isArray(history) || history.length > maxPriorQuestions) {
    throw new RequestError(400, 'Provide up to three prior questions.');
  }
  const priorQuestions = history.map((item: unknown) =>
    text(item, 'prior repository question', maxQuestionLength).trim(),
  );
  return { question, priorQuestions, contextWindow };
}

function bindAiRequest(reply: FastifyReply, shutdown: AbortSignal) {
  const client = new AbortController();
  const cancel = () => client.abort();
  reply.raw.once('close', cancel);
  if (reply.raw.destroyed) cancel();
  return {
    signal: AbortSignal.any([client.signal, shutdown]),
    release: () => reply.raw.off('close', cancel),
  };
}

function streamEvent(event: RepositoryStreamEvent) {
  return `${JSON.stringify(event)}\n`;
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
  const aiShutdown = new AbortController();
  let importing = false;
  let generating = false;
  let discovering = false;

  app.addHook('preClose', async () => {
    folderPickerShutdown.abort();
    aiShutdown.abort();
  });
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
    if (error instanceof GitBaselineError) return reply.code(422).send({ message: error.message });
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
        const key = 'example:field-notes:v2';
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
        return store.save(
          { name: basename(root), origin: 'local' },
          await analyze(root),
          undefined,
          root,
        );
      }
      if (Object.hasOwn(body, 'url')) {
        const input = text(body.url, 'public GitHub repository URL', 2048);
        const repo = parseGitHubUrl(input);
        const deadline = AbortSignal.timeout(90_000);
        const commitSha = await resolveGitHubRevision(repo, deadline);
        const cacheKey = `github:v3:${repo.url.toLowerCase()}:${commitSha}`;
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

  app.post<{ Params: { id: string } }>('/api/projects/:id/refresh', async ({ params }) => {
    const previous = getProject(params.id);
    const directory = store.workspaceRoot(params.id);
    if (!previous.project.canRefresh || !directory)
      throw new RequestError(400, 'Open the local working folder to refresh its snapshot.');
    if (importing) throw new RequestError(409, 'Wait for the current import to finish.');
    importing = true;
    try {
      const root = await localRoot(directory);
      if (root !== directory)
        throw new RequestError(400, 'The working folder has moved. Open it again.');
      const result = await analyze(root, previous);
      return store.save(
        { name: basename(root), origin: 'local' },
        result,
        undefined,
        root,
        params.id,
      );
    } finally {
      importing = false;
    }
  });

  function compare(baseline: ProjectAnalysis, current: ProjectAnalysis) {
    return compareSnapshots(
      baseline,
      current,
      store.sourceReader(baseline.project.id),
      store.sourceReader(current.project.id),
    );
  }

  app.get<{ Params: { id: string } }>('/api/projects/:id/baselines', async ({ params }) => {
    const { project } = getProject(params.id);
    const scope = store.scope(project);
    return store.list().filter((item) => item.id !== project.id && store.scope(item) === scope);
  });
  app.get<{ Params: { id: string }; Querystring: { baseline?: unknown } }>(
    '/api/projects/:id/compare',
    async ({ params, query }) => {
      const current = getProject(params.id);
      const baseline = getProject(text(query.baseline, 'baseline snapshot', 100));
      if (store.scope(current.project) !== store.scope(baseline.project))
        throw new RequestError(400, 'Choose a snapshot from the same repository.');
      return compare(baseline, current);
    },
  );
  app.post<{ Params: { id: string } }>('/api/projects/:id/compare-head', async ({ params }) => {
    const current = getProject(params.id);
    const directory = store.workspaceRoot(params.id);
    if (!directory || !current.project.canRefresh)
      throw new RequestError(400, 'Open a local Git working folder to compare with HEAD.');
    if (importing) throw new RequestError(409, 'Wait for the current import to finish.');
    importing = true;
    try {
      const root = await localRoot(directory);
      if (root !== directory)
        throw new RequestError(400, 'The working folder has moved. Open it again.');
      const git = await readGitHead(root);
      const cacheKey = `git-head:v1:${store.scope(current.project)}:${git.commit}`;
      const baseline =
        store.cached(cacheKey) ??
        (await git.snapshot(async (snapshot) =>
          store.save(
            { name: current.project.name, origin: 'local', commitSha: git.commit },
            await analyze(snapshot, current),
            cacheKey,
            root,
            params.id,
          ),
        ));
      return compare(baseline, current);
    } finally {
      importing = false;
    }
  });

  function requiredTrace(analysis: ProjectAnalysis, anchor: FlowAnchor) {
    const trace = buildCodeTrace(analysis, anchor);
    if (!trace)
      throw new RequestError(404, 'This route or function is unavailable in the snapshot.');
    return trace;
  }
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/api/projects/:id/trace',
    async ({ params, query }) => requiredTrace(getProject(params.id), flowAnchor(query)),
  );
  app.get<{ Params: { id: string } }>('/api/projects/:id/traces', async ({ params }) =>
    store.listTraces(getProject(params.id).project),
  );
  app.post<{ Params: { id: string } }>('/api/projects/:id/traces', async ({ params, body }) => {
    const analysis = getProject(params.id);
    const input = record(body);
    const anchor = flowAnchor(input);
    const title = text(input.title, 'trace title', 100).trim();
    const trace = requiredTrace(analysis, anchor);
    const saved = {
      id: randomUUID(),
      title,
      snapshotId: params.id,
      anchor,
      trace,
      fingerprints: traceFingerprints(trace, store.sourceReader(params.id)),
    };
    if (!store.saveTrace(analysis.project, saved))
      throw new RequestError(409, 'The saved trace limit is reached. Remove a trace to make room.');
    return saved;
  });
  app.get<{ Params: { id: string; traceId: string } }>(
    '/api/projects/:id/traces/:traceId',
    async ({ params }) => {
      const analysis = getProject(params.id);
      const saved = store.getTrace(analysis.project, params.traceId);
      if (!saved) throw new RequestError(404, 'This saved trace is unavailable.');
      return reviewSavedTrace(
        saved,
        buildCodeTrace(analysis, saved.anchor),
        store.sourceReader(params.id),
        store.has,
      );
    },
  );
  app.post<{ Params: { id: string; traceId: string } }>(
    '/api/projects/:id/traces/:traceId',
    async ({ params, body }) => {
      const analysis = getProject(params.id);
      const saved = store.getTrace(analysis.project, params.traceId);
      if (!saved) throw new RequestError(404, 'This saved trace is unavailable.');
      const trace = requiredTrace(analysis, saved.anchor);
      const read = store.sourceReader(params.id);
      const { stepId } = record(body);
      let updated;
      if (stepId === undefined) {
        updated = {
          ...saved,
          snapshotId: params.id,
          trace,
          fingerprints: traceFingerprints(trace, read),
          stepSnapshots: undefined,
        };
      } else {
        const stepKey = text(stepId, 'trace step', 64);
        const step = trace.steps.find(({ id }) => id === stepKey);
        if (!step || !Object.hasOwn(saved.fingerprints, stepKey))
          throw new RequestError(404, 'This step is unavailable in both trace versions.');
        updated = {
          ...saved,
          trace: {
            ...saved.trace,
            steps: saved.trace.steps.map((previous) => (previous.id === stepKey ? step : previous)),
          },
          fingerprints: {
            ...saved.fingerprints,
            ...traceFingerprints({ ...trace, steps: [step] }, read),
          },
          stepSnapshots: { ...saved.stepSnapshots, [stepKey]: params.id },
        };
      }
      store.saveTrace(analysis.project, updated);
      return reviewSavedTrace(updated, trace, read, store.has);
    },
  );
  app.delete<{ Params: { id: string; traceId: string } }>(
    '/api/projects/:id/traces/:traceId',
    async ({ params }) => {
      if (!store.deleteTrace(getProject(params.id).project, params.traceId))
        throw new RequestError(404, 'This saved trace is unavailable.');
      return { deleted: true };
    },
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
  app.post('/api/ai/models', async ({ body: input }, reply) => {
    const body = record(input);
    requireAiEnabled(body);
    const { provider, connection, local } = aiConnection(body);
    if (discovering)
      throw new RequestError(409, 'Wait for the current connection check to finish.');
    const request = bindAiRequest(reply, aiShutdown.signal);
    discovering = true;
    try {
      return { local, models: await provider.discover({ ...connection, signal: request.signal }) };
    } finally {
      request.release();
      discovering = false;
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/ai-context',
    async ({ params, body: input }) => {
      const body = record(input);
      requireAiEnabled(body);
      return prepareRepositoryQuestion(store, getProject(params.id), repositoryQuestion(body))
        .context;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/ask',
    async ({ params, body: input }, reply) => {
      const body = record(input);
      requireAiEnabled(body);
      const { provider, connection } = aiConnection(body);
      const model = text(body.model, 'model name', 200).trim();
      const question = repositoryQuestion(body);
      if (generating) throw new RequestError(409, 'Wait for the current AI response to finish.');
      const analysis = getProject(params.id);
      const prepared = prepareRepositoryQuestion(store, analysis, question);
      const request = bindAiRequest(reply, aiShutdown.signal);
      generating = true;

      async function* events() {
        try {
          for await (const event of answerRepositoryQuestion(
            store,
            analysis,
            provider,
            { ...connection, model, signal: request.signal },
            question.contextWindow,
            prepared,
          )) {
            if (request.signal.aborted) return;
            yield streamEvent(event);
          }
        } catch (error) {
          if (request.signal.aborted) return;
          const message =
            error instanceof AiProviderError
              ? error.message
              : 'The repository answer could not be completed.';
          yield streamEvent({ type: 'error', message });
        }
      }

      const stream = Readable.from(events());
      stream.once('close', () => {
        request.release();
        generating = false;
      });
      return reply.type('application/x-ndjson; charset=utf-8').send(stream);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/explain',
    async ({ params, body: input }, reply) => {
      const body = record(input);
      const { provider, connection } = aiConnection(body);
      const path = sourcePath(body.path);
      const model = text(body.model, 'model name', 200);
      const startLine = line(body.startLine);
      const endLine = line(body.endLine);
      if (generating) throw new RequestError(409, 'Wait for the current AI response to finish.');
      if (isSensitiveAiPath(path))
        throw new RequestError(400, 'Source in sensitive paths is excluded from AI requests.');
      const content = getSource(params.id, path);
      if (hasSensitiveAiSource(content))
        throw new RequestError(
          400,
          'This file appears to contain credentials and is excluded from AI requests.',
        );
      const request = bindAiRequest(reply, aiShutdown.signal);
      generating = true;
      try {
        return await explainSource(provider, {
          ...connection,
          path,
          content,
          model,
          startLine,
          endLine,
          signal: request.signal,
        });
      } finally {
        request.release();
        generating = false;
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
