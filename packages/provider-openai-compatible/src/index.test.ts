import { expect, it, vi } from 'vitest';
import { requestProviderJson } from '@arqivanta/ai-provider';
import { openAiCompatibleProvider } from './index.ts';

vi.mock('@arqivanta/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arqivanta/ai-provider')>()),
  requestProviderJson: vi.fn(),
}));

it('uses the supplied model and decodes a non-streaming completion', async () => {
  const input = {
    endpoint: 'http://127.0.0.1:8080',
    model: 'model-1',
    prompt: 'selected source',
  };
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
      messages: expect.arrayContaining([{ role: 'user', content: 'selected source' }]),
    }),
  );
});
