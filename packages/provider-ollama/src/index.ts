import {
  explanationInstructions,
  readModelNames,
  requestProviderEvents,
  requestProviderJson,
  requestProviderModelList,
  AiProviderError,
  type AiProvider,
  type AiProviderInput,
} from '@arqivanta/ai-provider';

const cloudConsentError = 'Explicit consent is required before using an Ollama cloud model.';

function isCloudModel(name: unknown): boolean {
  return typeof name === 'string' && /(?:-|:)cloud(?:$|:)/iu.test(name);
}

async function requireLocalModelWithoutConsent(input: AiProviderInput): Promise<void> {
  if (input.consent === true) return;
  if (isCloudModel(input.model)) throw new AiProviderError(cloudConsentError);

  const model = (await requestProviderJson(input, 'ollama-show', { model: input.model })) as {
    model_info?: unknown;
    remote_host?: unknown;
    remote_model?: unknown;
  } | null;
  if (model?.remote_host || model?.remote_model) {
    throw new AiProviderError(cloudConsentError);
  }
  if (
    !model?.model_info ||
    typeof model.model_info !== 'object' ||
    Array.isArray(model.model_info)
  ) {
    throw new AiProviderError('Ollama did not identify an installed local model.');
  }
}

export const ollamaProvider: AiProvider = {
  async discover(input) {
    const list = await requestProviderModelList(input, 'ollama-tags');
    if (list === null) return null;
    return readModelNames(list.models, (model) => {
      const name = typeof model.name === 'string' ? model.name : model.model;
      if (
        input.consent !== true &&
        (model.remote_host || model.remote_model || isCloudModel(name))
      ) {
        return undefined;
      }
      return name;
    });
  },

  async complete(input) {
    await requireLocalModelWithoutConsent(input);
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

  async *stream(input) {
    await requireLocalModelWithoutConsent(input);
    const events = requestProviderEvents(input, 'ollama-generate', {
      model: input.model,
      system: input.instructions,
      prompt: input.prompt,
      stream: true,
      options: { num_ctx: input.contextWindow, num_predict: input.outputTokens },
    });
    for await (const event of events) {
      if (event.done) return;
      if (typeof event.data.response === 'string' && event.data.response) yield event.data.response;
      if (event.data.done === true) return;
    }
    throw new AiProviderError('Ollama ended the stream before generation completed.');
  },
};
