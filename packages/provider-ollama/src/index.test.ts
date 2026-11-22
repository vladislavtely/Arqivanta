import { beforeEach, expect, it, vi } from 'vitest';
import {
  requestProviderEvents,
  requestProviderJson,
  requestProviderModelList,
} from '@arqivanta/ai-provider';
import { ollamaProvider } from './index.ts';

vi.mock('@arqivanta/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arqivanta/ai-provider')>()),
  requestProviderEvents: vi.fn(),
  requestProviderJson: vi.fn(),
  requestProviderModelList: vi.fn(),
}));

const input = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'local-model',
  prompt: 'selected source',
};

beforeEach(() => vi.resetAllMocks());

it('verifies the model is local before sending the prompt', async () => {
  vi.mocked(requestProviderJson)
    .mockResolvedValueOnce({ model_info: { architecture: 'llama' } })
    .mockResolvedValueOnce({ response: 'summary' });

  await expect(ollamaProvider.complete(input)).resolves.toBe('summary');
  expect(requestProviderJson).toHaveBeenNthCalledWith(1, input, 'ollama-show', {
    model: 'local-model',
  });
  expect(requestProviderJson).toHaveBeenNthCalledWith(
    2,
    input,
    'ollama-generate',
    expect.objectContaining({ prompt: 'selected source', stream: false }),
  );
});

it('does not send source to a cloud-backed alias without consent', async () => {
  vi.mocked(requestProviderJson).mockResolvedValue({ remote_host: 'https://ollama.com' });
  await expect(ollamaProvider.complete(input)).rejects.toThrow('Explicit consent');
  expect(requestProviderJson).toHaveBeenCalledExactlyOnceWith(input, 'ollama-show', {
    model: 'local-model',
  });
});

it('lists installed local models and deduplicates IDs', async () => {
  vi.mocked(requestProviderModelList).mockResolvedValue({
    models: [
      { name: 'local-model' },
      { model: 'local-model' },
      { name: 'custom-alias', remote_host: 'https://ollama.com' },
      { name: 'public-cloud' },
      { model: 'another-local-model' },
    ],
  });
  await expect(ollamaProvider.discover({ endpoint: input.endpoint })).resolves.toEqual([
    'local-model',
    'another-local-model',
  ]);
});

const streamInput = {
  ...input,
  instructions: 'answer briefly',
  contextWindow: 4_096,
  outputTokens: 500,
};

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const text of stream) chunks.push(text);
  return chunks;
}

it('streams only assistant text and applies the supplied generation limits', async () => {
  vi.mocked(requestProviderJson).mockResolvedValue({ model_info: { architecture: 'llama' } });
  async function* providerFrames(): ReturnType<typeof requestProviderEvents> {
    yield { done: false, data: { thinking: 'hidden' } };
    yield { done: false, data: { response: 'first ' } };
    yield { done: false, data: { response: 'second', done: true } };
  }
  vi.mocked(requestProviderEvents).mockReturnValue(providerFrames());
  await expect(collect(ollamaProvider.stream(streamInput))).resolves.toEqual(['first ', 'second']);
  expect(requestProviderEvents).toHaveBeenCalledExactlyOnceWith(
    streamInput,
    'ollama-generate',
    expect.objectContaining({
      system: streamInput.instructions,
      stream: true,
      options: { num_ctx: 4_096, num_predict: 500 },
    }),
  );
});

it('rechecks model locality before each streamed source request', async () => {
  vi.mocked(requestProviderJson).mockResolvedValue({ remote_model: 'upstream-model' });
  await expect(collect(ollamaProvider.stream(streamInput))).rejects.toThrow('Explicit consent');
  expect(requestProviderEvents).not.toHaveBeenCalled();
});
