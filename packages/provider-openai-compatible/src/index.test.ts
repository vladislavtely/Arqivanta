import { beforeEach, expect, it, vi } from 'vitest';
import {
  requestProviderEvents,
  requestProviderJson,
  requestProviderModelList,
} from '@arqivanta/ai-provider';
import { openAiCompatibleProvider } from './index.ts';

vi.mock('@arqivanta/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arqivanta/ai-provider')>()),
  requestProviderEvents: vi.fn(),
  requestProviderJson: vi.fn(),
  requestProviderModelList: vi.fn(),
}));

const input = {
  endpoint: 'http://127.0.0.1:8080',
  model: 'model-1',
  prompt: 'selected source',
};

beforeEach(() => vi.resetAllMocks());

it('uses the supplied model and decodes a non-streaming completion', async () => {
  vi.mocked(requestProviderJson).mockResolvedValue({
    choices: [{ message: { content: 'summary' } }],
  });
  await expect(openAiCompatibleProvider.complete(input)).resolves.toBe('summary');
  expect(requestProviderJson).toHaveBeenCalledExactlyOnceWith(
    input,
    'compatible-completion',
    expect.objectContaining({
      model: 'model-1',
      stream: false,
      max_tokens: 1_024,
      messages: expect.arrayContaining([{ role: 'user', content: 'selected source' }]),
    }),
  );
  expect(vi.mocked(requestProviderJson).mock.calls[0]?.[2]).not.toHaveProperty(
    'max_completion_tokens',
  );
});

it('lists model IDs and returns null when discovery is unsupported', async () => {
  vi.mocked(requestProviderModelList)
    .mockResolvedValueOnce({ data: [{ id: 'model-1' }, { id: 'model-1' }, { id: 'model-2' }] })
    .mockResolvedValueOnce(null);
  const options = { endpoint: input.endpoint };
  await expect(openAiCompatibleProvider.discover(options)).resolves.toEqual(['model-1', 'model-2']);
  await expect(openAiCompatibleProvider.discover(options)).resolves.toBeNull();
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

it('streams text without yielding tool calls or private reasoning fields', async () => {
  async function* providerFrames(): ReturnType<typeof requestProviderEvents> {
    yield { done: false, data: { choices: [{ delta: { role: 'assistant' } }] } };
    yield { done: false, data: { choices: [{ delta: { tool_calls: [{ name: 'test' }] } }] } };
    yield { done: false, data: { choices: [{ delta: { reasoning_content: 'hidden' } }] } };
    yield { done: false, data: { choices: [{ delta: { content: 'summary' } }] } };
    yield { done: true };
  }
  vi.mocked(requestProviderEvents).mockReturnValue(providerFrames());
  await expect(collect(openAiCompatibleProvider.stream(streamInput))).resolves.toEqual(['summary']);
  expect(requestProviderEvents).toHaveBeenLastCalledWith(streamInput, 'compatible-completion', {
    model: 'model-1',
    messages: [
      { role: 'system', content: 'answer briefly' },
      { role: 'user', content: 'selected source' },
    ],
    stream: true,
    max_tokens: 500,
  });
});

it('uses the current completion token parameter on remote endpoints', async () => {
  const remoteInput = { ...streamInput, endpoint: 'https://ai.example.com/v1', consent: true };
  vi.mocked(requestProviderJson).mockResolvedValue({
    choices: [{ message: { content: 'summary' } }],
  });
  async function* providerFrames(): ReturnType<typeof requestProviderEvents> {
    yield { done: false, data: { choices: [{ delta: { content: 'summary' } }] } };
    yield { done: true };
  }
  vi.mocked(requestProviderEvents).mockReturnValue(providerFrames());

  await expect(openAiCompatibleProvider.complete(remoteInput)).resolves.toBe('summary');
  await expect(collect(openAiCompatibleProvider.stream(remoteInput))).resolves.toEqual(['summary']);
  expect(requestProviderJson).toHaveBeenCalledExactlyOnceWith(
    remoteInput,
    'compatible-completion',
    expect.objectContaining({ max_completion_tokens: 1_024 }),
  );
  expect(requestProviderEvents).toHaveBeenCalledExactlyOnceWith(
    remoteInput,
    'compatible-completion',
    expect.objectContaining({ max_completion_tokens: 500 }),
  );
  expect(vi.mocked(requestProviderJson).mock.calls[0]?.[2]).not.toHaveProperty('max_tokens');
  expect(vi.mocked(requestProviderEvents).mock.calls[0]?.[2]).not.toHaveProperty('max_tokens');
});

it('reports a stream that closes without a completion marker', async () => {
  async function* providerFrames(): ReturnType<typeof requestProviderEvents> {
    yield { done: false, data: { choices: [{ delta: { content: 'incomplete' } }] } };
  }
  vi.mocked(requestProviderEvents).mockReturnValue(providerFrames());
  await expect(collect(openAiCompatibleProvider.stream(streamInput))).rejects.toThrow(
    'ended the stream before generation completed',
  );
});
