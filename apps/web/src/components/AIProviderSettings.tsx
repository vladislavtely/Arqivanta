import { useLayoutEffect, useRef, useState } from 'react';
import { repositoryAiLimits } from '@arqivanta/shared';
import { ChevronDown, LockKeyhole, Plug, Settings2 } from 'lucide-react';
import { api, errorMessage, post } from '../api';
import { initialAISettings, providerConnection } from './ai-settings';
import type { AISettings, Destination, Provider } from './ai-settings';
import { ErrorNotice, Loading } from './ui';

type Discovery = { local: boolean; models: string[] | null };

export function AIProviderSettings({
  active,
  settings,
  destination,
  connectionRevision,
  onSettings,
}: {
  active: boolean;
  settings: AISettings;
  destination: Destination | undefined;
  connectionRevision: number;
  onSettings: (settings: AISettings) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery>();
  const [failure, setFailure] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);

  useLayoutEffect(() => {
    setConsent(false);
    setConnecting(false);
    return () => {
      request.current?.abort();
      request.current = undefined;
    };
  }, [active, settings]);

  useLayoutEffect(() => {
    setDiscovery(undefined);
    setFailure(undefined);
  }, [connectionRevision]);

  async function discover() {
    if (
      !active ||
      !settings.enabled ||
      !destination ||
      request.current ||
      (!destination.local && !consent)
    )
      return;
    const abort = new AbortController();
    request.current = abort;
    setConnecting(true);
    setConsent(false);
    setFailure(undefined);
    setDiscovery(undefined);
    try {
      const result = await api<Discovery>(
        '/ai/models',
        post(
          {
            ...providerConnection(settings),
            enabled: true,
            consent: !destination.local && consent,
          },
          abort.signal,
        ),
      );
      if (!abort.signal.aborted) setDiscovery(result);
    } catch (cause) {
      if (!abort.signal.aborted) setFailure(errorMessage(cause));
    } finally {
      if (request.current === abort) {
        request.current = undefined;
        setConnecting(false);
      }
    }
  }

  return (
    <section className="panel settings-panel assistant-provider" aria-labelledby="provider-title">
      <h2 id="provider-title">
        <Settings2 size={17} aria-hidden="true" /> Provider settings
      </h2>
      <fieldset className="settings-form" disabled={!settings.enabled}>
        <div>
          <label htmlFor="ai-provider">Provider</label>
          <div className="select-field">
            <select
              id="ai-provider"
              value={settings.provider}
              onChange={(event) => {
                const provider = event.target.value as Provider;
                onSettings({
                  ...settings,
                  provider,
                  endpoint:
                    provider === 'ollama' ? initialAISettings.endpoint : 'http://127.0.0.1:1234/v1',
                  model: '',
                  apiKey: '',
                });
              }}
            >
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </div>
        </div>
        <div>
          <label htmlFor="ai-endpoint">Endpoint</label>
          <input
            id="ai-endpoint"
            type="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={2048}
            value={settings.endpoint}
            onChange={(event) => onSettings({ ...settings, endpoint: event.target.value })}
            aria-describedby="ai-endpoint-type"
          />
          <p
            className={`assistant-destination${destination && !destination.local ? ' remote' : ''}`}
            id="ai-endpoint-type"
          >
            {destination
              ? destination.local
                ? 'Loopback endpoint'
                : 'Remote endpoint'
              : 'Enter a valid loopback or HTTPS endpoint.'}
          </p>
        </div>
        <div>
          <label htmlFor="ai-api-key">API key (optional)</label>
          <input
            id="ai-api-key"
            type="password"
            autoComplete="off"
            maxLength={4096}
            value={settings.apiKey}
            onChange={(event) => onSettings({ ...settings, apiKey: event.target.value })}
          />
        </div>
        {destination && !destination.local && (
          <label className="consent-control discovery-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I consent to contacting <strong>{destination.label}</strong> with the configured
              credentials for model discovery.
            </span>
          </label>
        )}
        <button
          className="button"
          type="button"
          onClick={() => {
            void discover();
          }}
          disabled={!destination || connecting || (!destination.local && !consent)}
        >
          <Plug size={15} aria-hidden="true" /> Discover models
        </button>
        {connecting && <Loading>Connecting to the provider…</Loading>}
        {failure && <ErrorNotice message={failure} />}
        {discovery && (
          <p className="discovery-status" role="status">
            {discovery.models === null
              ? 'Endpoint responded. Model discovery is unavailable. Enter a model name manually.'
              : discovery.local
                ? 'Connected to a loopback endpoint.'
                : 'Connected to the remote endpoint.'}
            {discovery.models?.length === 0 && ' No models listed. Enter a model name manually.'}
          </p>
        )}
        {Boolean(discovery?.models?.length) && (
          <div>
            <label htmlFor="ai-discovered-models">Discovered models</label>
            <div className="select-field">
              <select
                id="ai-discovered-models"
                value={discovery?.models?.includes(settings.model) ? settings.model : ''}
                onChange={(event) => onSettings({ ...settings, model: event.target.value })}
              >
                <option value="" disabled>
                  Choose a model
                </option>
                {discovery?.models?.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </div>
          </div>
        )}
        <div>
          <label htmlFor="ai-model">Model name</label>
          <input
            id="ai-model"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            value={settings.model}
            onChange={(event) => onSettings({ ...settings, model: event.target.value })}
            placeholder="Enter a model ID"
          />
        </div>
        <div>
          <label htmlFor="ai-context-window">Context window</label>
          <input
            id="ai-context-window"
            type="number"
            min={repositoryAiLimits.minContextWindow}
            max={repositoryAiLimits.maxContextWindow}
            step={1}
            value={settings.contextWindow}
            onChange={(event) => onSettings({ ...settings, contextWindow: event.target.value })}
            aria-describedby="ai-context-window-hint"
          />
          <p className="field-hint" id="ai-context-window-hint">
            2,048–32,768 tokens.
          </p>
        </div>
      </fieldset>
      <p className="privacy-note">
        <LockKeyhole size={15} aria-hidden="true" /> Your settings and key stay in this session. Use
        a loopback endpoint you trust to keep inference on this machine.
      </p>
    </section>
  );
}

export function SourceConsent({
  destination,
  scope,
  checked,
  onChecked,
}: {
  destination: Destination | undefined;
  scope: 'response' | 'explanation';
  checked: boolean;
  onChecked: (checked: boolean) => void;
}) {
  if (!destination || (destination.local && !destination.ollamaRelay)) return null;
  const data =
    scope === 'response'
      ? 'this question, recent questions, and selected source excerpts'
      : 'the selected source excerpt';
  return (
    <label className="consent-control">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChecked(event.target.checked)}
      />
      {destination.local ? (
        <span>
          I allow the Ollama server at <strong>{destination.label}</strong> to send {data} to its
          cloud model for this {scope}.
        </span>
      ) : (
        <span>
          I consent to sending {data} to <strong>{destination.label}</strong> for this {scope}.
        </span>
      )}
    </label>
  );
}
