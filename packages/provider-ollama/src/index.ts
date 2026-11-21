import {
  explanationInstructions,
  requestProviderJson,
  AiProviderError,
  type AiProvider,
} from '@arqivanta/ai-provider';

export const ollamaProvider: AiProvider = {
  async complete(input) {
    if (input.consent !== true) {
      if (/(?:-|:)cloud(?:$|:)/iu.test(input.model)) {
        throw new AiProviderError(
          'Explicit consent is required before using an Ollama cloud model.',
        );
      }
      const model = (await requestProviderJson(input, 'ollama-show', { model: input.model })) as {
        model_info?: unknown;
        remote_host?: unknown;
        remote_model?: unknown;
      } | null;
      if (model?.remote_host || model?.remote_model) {
        throw new AiProviderError(
          'Explicit consent is required before using an Ollama cloud model.',
        );
      }
      if (!model?.model_info || typeof model.model_info !== 'object') {
        throw new AiProviderError('Ollama did not identify an installed local model.');
      }
    }
    const result = (await requestProviderJson(input, 'ollama-generate', {
      model: input.model,
      system: explanationInstructions,
      prompt: input.prompt,
      stream: false,
      options: { num_predict: 1_024 },
    })) as { response?: unknown } | null;
    if (typeof result?.response !== 'string') {
      throw new AiProviderError('Ollama did not return an explanation.');
    }
    return result.response;
  },
};
