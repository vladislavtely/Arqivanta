export async function api<T>(route: string, options?: RequestInit): Promise<T> {
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

  return (await response.json()) as T;
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
