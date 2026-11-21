import { useEffect, useRef, useState } from 'react';
import type { ProjectAnalysis, SourceRef } from '@arqivanta/shared';
import { ChevronDown, FileCode2, LockKeyhole, Sparkles } from 'lucide-react';
import { api, errorMessage, post, projectRoute } from '../api';
import type { FileSelection } from './Explorer';
import { ErrorNotice, Loading } from './ui';

type Provider = 'ollama' | 'openai-compatible';

export type AISettings = {
  enabled: boolean;
  provider: Provider;
  endpoint: string;
  model: string;
  apiKey: string;
};

export const initialAISettings: AISettings = {
  enabled: false,
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: '',
  apiKey: '',
};

type Explanation = { text: string; references: SourceRef[] };

function isRemote(endpoint: string): boolean {
  try {
    return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname.toLowerCase());
  } catch {
    return true;
  }
}

function ExplanationForm({
  settings,
  analysis,
  selection,
  onOpen,
}: {
  settings: AISettings;
  analysis: ProjectAnalysis;
  selection: FileSelection;
  onOpen: (selection: FileSelection) => void;
}) {
  const [start, setStart] = useState(selection.line?.toString() ?? '');
  const [end, setEnd] = useState('');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [response, setResponse] = useState<Explanation>();
  const request = useRef<AbortController | undefined>(undefined);
  const file = analysis.files.find((file) => file.path === selection.path);
  const remote = isRemote(settings.endpoint);
  const ollamaRelay = !remote && settings.provider === 'ollama';
  const cloudModel = ollamaRelay && /(?:-|:)cloud(?:$|:)/iu.test(settings.model.trim());
  const requiresConsent = remote || cloudModel;

  useEffect(() => () => request.current?.abort(), []);

  async function explain() {
    if (pending || (requiresConsent && !consent)) return;
    setError(undefined);
    setResponse(undefined);
    if (start && end && Number(start) > Number(end)) {
      setError('The end line must be at or after the start line.');
      return;
    }

    const abort = new AbortController();
    request.current = abort;
    setPending(true);
    setConsent(false);
    try {
      const result = await api<Explanation>(
        `${projectRoute(analysis.project.id)}/explain`,
        post(
          {
            path: selection.path,
            provider: settings.provider,
            endpoint: settings.endpoint.trim(),
            model: settings.model.trim(),
            apiKey: settings.apiKey || undefined,
            consent: (remote || ollamaRelay) && consent,
            startLine: start ? Number(start) : undefined,
            endLine: end ? Number(end) : undefined,
          },
          abort.signal,
        ),
      );
      if (!abort.signal.aborted) setResponse(result);
    } catch (cause) {
      if (!abort.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!abort.signal.aborted) setPending(false);
    }
  }

  return (
    <>
      <p className="ai-source">
        <FileCode2 size={16} aria-hidden="true" /> {selection.path}
      </p>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void explain();
        }}
      >
        <div className="field-group">
          <div>
            <label htmlFor="ai-start">Start line</label>
            <input
              id="ai-start"
              type="number"
              min={1}
              max={file?.lines}
              value={start}
              onChange={(event) => setStart(event.target.value)}
              placeholder="Optional"
            />
          </div>
          <div>
            <label htmlFor="ai-end">End line</label>
            <input
              id="ai-end"
              type="number"
              min={1}
              max={file?.lines}
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        {(remote || ollamaRelay) && (
          <label className="consent-control">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            {remote ? (
              <span>
                I consent to sending the source excerpt to <strong>{settings.endpoint}</strong> for
                this explanation.
              </span>
            ) : (
              <span>
                I allow the Ollama server at <strong>{settings.endpoint}</strong> to send the source
                excerpt to its cloud model for this explanation.
              </span>
            )}
          </label>
        )}
        <button
          className="button primary"
          type="submit"
          disabled={
            pending ||
            !settings.model.trim() ||
            !settings.endpoint.trim() ||
            (requiresConsent && !consent)
          }
        >
          <Sparkles size={16} aria-hidden="true" /> Generate explanation
        </button>
      </form>
      {pending && <Loading>Waiting for the selected model…</Loading>}
      {error && <ErrorNotice message={error} />}
      {response && (
        <section className="explanation-result" aria-live="polite">
          <h3>Explanation</h3>
          <p>{response.text}</p>
          {response.references.length > 0 && <h3>Source references</h3>}
          <ul className="graph-references">
            {response.references.map((reference, index) => (
              <li key={index}>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onOpen({ path: reference.path, line: reference.startLine })}
                >
                  {reference.path}:{reference.startLine}
                  {reference.endLine > reference.startLine && `–${reference.endLine}`}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function AI({
  settings,
  analysis,
  selection,
  onSettings,
  onSelect,
  onOpen,
}: {
  settings: AISettings;
  analysis: ProjectAnalysis | undefined;
  selection: FileSelection | undefined;
  onSettings: (settings: AISettings) => void;
  onSelect: (selection: FileSelection) => void;
  onOpen: (selection: FileSelection) => void;
}) {
  return (
    <div className="page workbench-page settings-page">
      <header className="workbench-header">
        <div>
          <h1>AI Explanations</h1>
          <p>Use a model you choose to explain source from the current snapshot.</p>
        </div>
      </header>
      <div className="settings-grid">
        <section className="panel settings-panel" aria-labelledby="provider-title">
          <span className="feature-icon">
            <Sparkles size={20} aria-hidden="true" />
          </span>
          <h2 id="provider-title">AI provider settings</h2>
          <label className="consent-control switch-control">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => onSettings({ ...settings, enabled: event.target.checked })}
            />
            <span>Enable AI explanations</span>
          </label>
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
                        provider === 'ollama'
                          ? initialAISettings.endpoint
                          : 'http://127.0.0.1:1234/v1',
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
              />
            </div>
            <div>
              <label htmlFor="ai-model">Model name</label>
              <input
                id="ai-model"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                value={settings.model}
                onChange={(event) => onSettings({ ...settings, model: event.target.value })}
                placeholder="Installed model ID"
              />
            </div>
            {settings.provider === 'openai-compatible' && (
              <div>
                <label htmlFor="ai-api-key">API key (optional)</label>
                <input
                  id="ai-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                  value={settings.apiKey}
                  onChange={(event) => onSettings({ ...settings, apiKey: event.target.value })}
                />
              </div>
            )}
          </fieldset>
          <p className="privacy-note">
            <LockKeyhole size={15} aria-hidden="true" /> Settings and keys are kept in memory for
            this session. Use a loopback endpoint you trust to keep inference on this machine.
          </p>
        </section>

        <section className="panel settings-panel" aria-labelledby="explanation-title">
          <h2 id="explanation-title">Explain a file</h2>
          {!analysis?.files.length ? (
            <p>Open a repository with source files to use explanations.</p>
          ) : (
            <>
              <label className="select-field ai-file-select">
                <select
                  aria-label="File to explain"
                  value={selection?.path ?? ''}
                  onChange={(event) => onSelect({ path: event.target.value })}
                >
                  {!selection && (
                    <option value="" disabled>
                      Select a file
                    </option>
                  )}
                  {analysis.files.map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.path}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} aria-hidden="true" />
              </label>
              {!settings.enabled && (
                <p className="settings-empty">Enable AI explanations to send a request.</p>
              )}
              {settings.enabled && selection && (
                <ExplanationForm
                  key={JSON.stringify([
                    analysis.project.id,
                    selection.path,
                    settings.provider,
                    settings.endpoint,
                    settings.model,
                  ])}
                  settings={settings}
                  analysis={analysis}
                  selection={selection}
                  onOpen={onOpen}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
