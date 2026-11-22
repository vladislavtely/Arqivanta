import type { AiConnectionInput } from './index.ts';
import { AiProviderError } from './errors.ts';
import { requestProviderBody } from './transport.ts';

const MAX_FRAME_CHARS = 512 * 1024;

type ProviderEvent = { done: false; data: Record<string, unknown> } | { done: true };
type StreamRoute = 'ollama-generate' | 'compatible-completion';

function ensureFrameSize(length: number): void {
  if (length > MAX_FRAME_CHARS) {
    throw new AiProviderError('An AI provider stream message exceeded the size limit.');
  }
}

async function* readLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = '';
  let trailingCr = false;

  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (!text) continue;
    const lines = (trailingCr && text.startsWith('\n') ? text.slice(1) : text).split(/\r\n?|\n/u);
    trailingCr = text.endsWith('\r');

    const tail = lines.pop()!;
    if (lines.length) {
      lines[0] = pending + lines[0];
      for (const line of lines) {
        ensureFrameSize(line.length);
        yield line;
      }
      pending = '';
    }
    pending += tail;
    ensureFrameSize(pending.length);
  }

  pending += decoder.decode();
  ensureFrameSize(pending.length);
  if (pending) yield pending;
}

function parseChunk(chunk: string): ProviderEvent {
  let data: unknown;
  try {
    data = JSON.parse(chunk) as unknown;
  } catch {
    throw new AiProviderError('The AI provider returned an invalid stream message.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AiProviderError('The AI provider returned an invalid stream message.');
  }
  if ('error' in data && data.error != null) {
    throw new AiProviderError('The AI provider reported an error during generation.');
  }
  return { done: false, data: data as Record<string, unknown> };
}

async function* readSse(lines: AsyncIterable<string>): AsyncGenerator<ProviderEvent> {
  let dataLines: string[] = [];
  let frameLength = 0;
  let eventType = '';
  for await (const line of lines) {
    if (!line) {
      if (eventType === 'error') {
        throw new AiProviderError('The AI provider reported an error during generation.');
      }
      const data = dataLines.join('\n').trim();
      if (data === '[DONE]') {
        yield { done: true };
        return;
      }
      if (data) yield parseChunk(data);
      dataLines = [];
      frameLength = 0;
      eventType = '';
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'event') eventType = value;
    if (field === 'data') {
      frameLength += value.length + 1;
      ensureFrameSize(frameLength);
      dataLines.push(value);
    }
  }
}

async function* readNdjson(lines: AsyncIterable<string>): AsyncGenerator<ProviderEvent> {
  for await (const line of lines) {
    if (line.trim()) yield parseChunk(line);
  }
}

export async function* requestProviderEvents(
  input: AiConnectionInput,
  route: StreamRoute,
  body: object,
): AsyncGenerator<ProviderEvent> {
  const isSse = route === 'compatible-completion';
  const format = isSse ? 'text/event-stream' : 'application/x-ndjson';
  const lines = readLines(requestProviderBody(input, route, format, body));
  const events = isSse ? readSse(lines) : readNdjson(lines);
  for await (const event of events) {
    if (input.signal?.aborted) throw new AiProviderError('The AI request was canceled.');
    yield event;
  }
}
