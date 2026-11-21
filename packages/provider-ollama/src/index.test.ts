import { beforeEach, expect, it, vi } from 'vitest';
import { requestProviderJson } from '@arqivanta/ai-provider';
import { ollamaProvider } from './index.ts';

vi.mock('@arqivanta/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arqivanta/ai-provider')>()),
  requestProviderJson: vi.fn(),
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
