import {
  explanationInstructions,
  parseAiEndpoint,
  readModelNames,
  requestProviderEvents,
  requestProviderJson,
  requestProviderModelList,
  AiProviderError,
  type AiConnectionInput,
  type AiProvider,
} from '@arqivanta/ai-provider';

function outputLimit(input: AiConnectionInput, tokens: number) {
  const { local } = parseAiEndpoint(input.endpoint, input.consent);
  return local ? { max_tokens: tokens } : { max_completion_tokens: tokens };
}

export const openAiCompatibleProvider: AiProvider = {
  async discover(input) {
    const list = await requestProviderModelList(input, 'compatible-models');
    return list === null ? null : readModelNames(list.data, (model) => model.id);
  },

  async complete(input) {
    const result = (await requestProviderJson(input, 'compatible-completion', {
      model: input.model,
      messages: [
        { role: 'system', content: explanationInstructions },
        { role: 'user', content: input.prompt },
      ],
      stream: false,
      ...outputLimit(input, 1_024),
    })) as { choices?: { message?: { content?: unknown } }[] } | null;
    const text = result?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new AiProviderError('The compatible endpoint did not return an explanation.');
    }
    return text;
  },

  async *stream(input) {
    const events = requestProviderEvents(input, 'compatible-completion', {
      model: input.model,
      messages: [
        { role: 'system', content: input.instructions },
        { role: 'user', content: input.prompt },
      ],
      stream: true,
      ...outputLimit(input, input.outputTokens),
    });
    let finished = false;
    for await (const event of events) {
      if (event.done) return;
      const choices = event.data.choices as
        { delta?: { content?: unknown }; finish_reason?: unknown }[] | undefined;
      const choice = choices?.[0];
      const text = choice?.delta?.content;
      if (typeof text === 'string' && text) yield text;
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finished = true;
    }
    if (!finished) {
      throw new AiProviderError(
        'The compatible endpoint ended the stream before generation completed.',
      );
    }
  },
};
