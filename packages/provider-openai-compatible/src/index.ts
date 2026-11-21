import {
  explanationInstructions,
  requestProviderJson,
  AiProviderError,
  type AiProvider,
} from '@arqivanta/ai-provider';

export const openAiCompatibleProvider: AiProvider = {
  async complete(input) {
    const result = (await requestProviderJson(input, 'compatible-completion', {
      model: input.model,
      messages: [
        { role: 'system', content: explanationInstructions },
        { role: 'user', content: input.prompt },
      ],
      stream: false,
      max_completion_tokens: 1_024,
    })) as { choices?: { message?: { content?: unknown } }[] } | null;
    const text = result?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new AiProviderError('The compatible endpoint did not return an explanation.');
    }
    return text;
  },
};
