import { useLayoutEffect, useRef, useState } from 'react';
import type { ProjectAnalysis, SourceRef } from '@arqivanta/shared';
import { ChevronDown, FileCode2, MessageSquare, Sparkles } from 'lucide-react';
import { api, errorMessage, post, projectRoute } from '../api';
import { AIProviderSettings, SourceConsent } from './AIProviderSettings';
import {
  describeDestination,
  providerConnection,
  referenceLabel,
  sourceSelection,
} from './ai-settings';
import type { AISettings, Destination } from './ai-settings';
import type { FileSelection } from './Explorer';
import { RepositoryChat } from './RepositoryChat';
import { ErrorNotice, Loading } from './ui';

export type AssistantView = 'ask' | 'explain';

type Explanation = { text: string; references: SourceRef[] };

function ExplanationForm({
  settings,
  destination,
  analysis,
  selection,
  onOpen,
}: {
  settings: AISettings;
  destination: Destination | undefined;
  analysis: ProjectAnalysis;
  selection: FileSelection;
  onOpen: (selection: FileSelection) => void;
}) {
  const [start, setStart] = useState(selection.line?.toString() ?? '');
  const [end, setEnd] = useState(selection.endLine?.toString() ?? '');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [response, setResponse] = useState<Explanation>();
  const request = useRef<AbortController | undefined>(undefined);
  const file = analysis.files.find((file) => file.path === selection.path);
  const canExplain =
    destination && settings.model.trim() && (!destination.requiresSourceConsent || consent);

  useLayoutEffect(() => () => request.current?.abort(), []);

  async function explain() {
    if (!settings.enabled || !destination || !canExplain || request.current) return;
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
            ...providerConnection(settings),
            model: settings.model.trim(),
            consent: (!destination.local || destination.ollamaRelay) && consent,
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
      if (!abort.signal.aborted) {
        request.current = undefined;
        setPending(false);
      }
    }
  }

  return (
    <>
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
              onChange={(event) => {
                setStart(event.target.value);
                setConsent(false);
              }}
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
              onChange={(event) => {
                setEnd(event.target.value);
                setConsent(false);
              }}
              placeholder="Optional"
            />
          </div>
        </div>
        <SourceConsent
          destination={destination}
          scope="explanation"
          checked={consent}
          onChecked={setConsent}
        />
        <button className="button primary" type="submit" disabled={pending || !canExplain}>
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
                  onClick={() => onOpen(sourceSelection(reference))}
                >
                  {referenceLabel(reference)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

const assistantTabs = [
  { id: 'ask', name: 'Ask Repository', Icon: MessageSquare },
  { id: 'explain', name: 'Explain a file', Icon: FileCode2 },
] as const;

export function AI({
  settings,
  settingsRevision,
  connectionRevision,
  analysis,
  selection,
  onSettings,
  onSelect,
  onOpen,
  active,
  view,
  onView,
}: {
  settings: AISettings;
  settingsRevision: number;
  connectionRevision: number;
  analysis: ProjectAnalysis | undefined;
  selection: FileSelection | undefined;
  onSettings: (settings: AISettings) => void;
  onSelect: (selection: FileSelection) => void;
  onOpen: (selection: FileSelection) => void;
  active: boolean;
  view: AssistantView;
  onView: (view: AssistantView) => void;
}) {
  const destination = describeDestination(settings);

  return (
    <div className="page workbench-page assistant-page">
      <header className="workbench-header assistant-heading">
        <div>
          <h1>Repository AI Assistant</h1>
          <p>
            {analysis
              ? `Ask questions about ${analysis.project.name} and follow answers back to source.`
              : 'Open a repository to ask questions about its source and architecture.'}
          </p>
        </div>
        <label className="consent-control assistant-enable">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => onSettings({ ...settings, enabled: event.target.checked })}
          />
          <span>Enable AI assistant</span>
        </label>
      </header>
      <div
        className="assistant-tabs"
        role="tablist"
        aria-label="Assistant workflow"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const next =
            event.key === 'Home'
              ? 'ask'
              : event.key === 'End'
                ? 'explain'
                : view === 'ask'
                  ? 'explain'
                  : 'ask';
          event.preventDefault();
          onView(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`#assistant-tab-${next}`)?.focus();
        }}
      >
        {assistantTabs.map(({ id, name, Icon }) => (
          <button
            key={id}
            className="assistant-tab"
            type="button"
            role="tab"
            id={`assistant-tab-${id}`}
            aria-controls={`assistant-panel-${id}`}
            aria-selected={view === id}
            tabIndex={view === id ? 0 : -1}
            onClick={() => onView(id)}
          >
            <Icon size={16} aria-hidden="true" /> {name}
          </button>
        ))}
      </div>

      <div className="assistant-layout">
        <div
          role="tabpanel"
          id="assistant-panel-ask"
          aria-labelledby="assistant-tab-ask"
          hidden={view !== 'ask'}
        >
          <RepositoryChat
            active={active && view === 'ask'}
            analysis={analysis}
            settings={settings}
            destination={destination}
            settingsRevision={settingsRevision}
            connectionRevision={connectionRevision}
            onOpen={onOpen}
          />
        </div>
        <div
          role="tabpanel"
          id="assistant-panel-explain"
          aria-labelledby="assistant-tab-explain"
          hidden={view !== 'explain'}
        >
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
                  <p className="settings-empty">
                    Enable the assistant in this workspace to explain a file.
                  </p>
                )}
                {active && view === 'explain' && settings.enabled && selection && (
                  <ExplanationForm
                    key={JSON.stringify([
                      selection.path,
                      selection.line,
                      selection.endLine,
                      settingsRevision,
                    ])}
                    settings={settings}
                    destination={destination}
                    analysis={analysis}
                    selection={selection}
                    onOpen={onOpen}
                  />
                )}
              </>
            )}
          </section>
        </div>
        <AIProviderSettings
          active={active}
          settings={settings}
          destination={destination}
          connectionRevision={connectionRevision}
          onSettings={onSettings}
        />
      </div>
    </div>
  );
}
