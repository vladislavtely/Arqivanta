import type { RepositoryStreamEvent } from '@arqivanta/shared';

async function request(route: string, options?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api${route}`, options);
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new Error('The local server could not be reached. Check that Arqivanta is running.');
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
    ) {
      throw new Error(body.message);
    }
    throw new Error(`The request failed (${response.status}).`);
  }

  return response;
}

export async function api<T>(route: string, options?: RequestInit): Promise<T> {
  const response = await request(route, options);
  return (await response.json()) as T;
}

export async function streamRepositoryAnswer(
  route: string,
  body: object,
  signal: AbortSignal,
  onEvent: (event: RepositoryStreamEvent) => void,
): Promise<void> {
  const response = await request(route, post(body, signal));
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    throw new Error('The local server did not return an assistant response stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  function receive(line: string): boolean {
    if (!line.trim()) return false;
    let event: RepositoryStreamEvent;
    try {
      event = JSON.parse(line) as RepositoryStreamEvent;
      if (!['context', 'delta', 'done', 'error'].includes(event.type)) throw new Error();
    } catch {
      throw new Error('The local server returned an invalid assistant response.');
    }
    onEvent(event);
    return event.type === 'done' || event.type === 'error';
  }

  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (receive(pending + decoder.decode())) return;
        break;
      }
      const lines = (pending + decoder.decode(chunk.value, { stream: true })).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (receive(line)) return;
    }
    if (!signal.aborted) throw new Error('The assistant response ended early.');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function post(body: object, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
}

export function projectRoute(id: string): string {
  return `/projects/${encodeURIComponent(id)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
