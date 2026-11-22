import { repositoryAiLimits } from '@arqivanta/shared';
import type { SourceRef } from '@arqivanta/shared';
import type { FileSelection } from './Explorer';

export type Provider = 'ollama' | 'openai-compatible';

export type AISettings = {
  enabled: boolean;
  provider: Provider;
  endpoint: string;
  model: string;
  apiKey: string;
  contextWindow: string;
};

export const initialAISettings: AISettings = {
  enabled: false,
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: '',
  apiKey: '',
  contextWindow: String(repositoryAiLimits.defaultContextWindow),
};

export function connectionChanged(previous: AISettings, next: AISettings): boolean {
  return (
    previous.enabled !== next.enabled ||
    previous.provider !== next.provider ||
    previous.endpoint !== next.endpoint ||
    previous.apiKey !== next.apiKey
  );
}

export function describeDestination(settings: AISettings) {
  let endpoint: URL;
  try {
    endpoint = new URL(settings.endpoint.trim());
  } catch {
    return undefined;
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    return undefined;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (!local && endpoint.protocol !== 'https:') return undefined;
  const ollamaRelay = local && settings.provider === 'ollama';
  return {
    local,
    ollamaRelay,
    requiresSourceConsent:
      !local || (ollamaRelay && /(?:-|:)cloud(?:$|:)/iu.test(settings.model.trim())),
    label: `${endpoint.origin}${endpoint.pathname === '/' ? '' : endpoint.pathname}`,
  };
}

export type Destination = NonNullable<ReturnType<typeof describeDestination>>;

export function providerConnection(settings: AISettings) {
  return {
    provider: settings.provider,
    endpoint: settings.endpoint.trim(),
    apiKey: settings.apiKey || undefined,
  };
}

export function sourceSelection(reference: SourceRef): FileSelection {
  return { path: reference.path, line: reference.startLine, endLine: reference.endLine };
}

export function referenceLabel({ path, startLine, endLine }: SourceRef): string {
  return `${path}:${startLine}${startLine === endLine ? '' : `–${endLine}`}`;
}
