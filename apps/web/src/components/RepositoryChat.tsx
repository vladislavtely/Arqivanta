import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { repositoryAiLimits } from '@arqivanta/shared';
import type { ProjectAnalysis, RepositoryCitation, RepositoryContext } from '@arqivanta/shared';
import { Braces, MessageSquare, Send, Square } from 'lucide-react';
import { api, errorMessage, post, projectRoute, streamRepositoryAnswer } from '../api';
import { SourceConsent } from './AIProviderSettings';
import { providerConnection, referenceLabel, sourceSelection } from './ai-settings';
import type { AISettings, Destination } from './ai-settings';
import type { FileSelection } from './Explorer';
import { ErrorNotice, plural } from './ui';

type Turn = {
  id: number;
  connection: number;
  question: string;
  text: string;
  status: 'streaming' | 'done' | 'stopped' | 'error';
  context?: RepositoryContext;
  citations?: RepositoryCitation[];
  error?: string;
};

type Request =
  | { abort: AbortController; mode: 'preview' }
  | { abort: AbortController; mode: 'ask'; turnId: number };

const exampleQuestions = [
  'Where does this application start?',
  'How do the main modules depend on each other?',
  'Which files should I read first to understand this codebase?',
];
const retainedTurns = 24;

function ContextDetails({
  context,
  onOpen,
  initiallyOpen,
}: {
  context: RepositoryContext;
  onOpen: (file: FileSelection) => void;
  initiallyOpen?: boolean;
}) {
  return (
    <details className="assistant-context" open={initiallyOpen}>
      <summary aria-label="Inspect context">
        Inspect context{' '}
        <span>
          {plural(context.excerpts.length, 'excerpt')} · ~{context.estimatedTokens.toLocaleString()}{' '}
          tokens
        </span>
      </summary>
      <div className="assistant-context-body">
        {context.excerpts.length === 0 && <p>No source excerpts were selected.</p>}
        <ul className="assistant-excerpts">
          {context.excerpts.map((excerpt) => (
            <li key={excerpt.id}>
              <div className="excerpt-label">
                <span>{excerpt.id}</span>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => onOpen(sourceSelection(excerpt))}
                >
                  {referenceLabel(excerpt)}
                </button>
              </div>
              <pre tabIndex={0} aria-label={`Source excerpt ${excerpt.id}`}>
                <code>{excerpt.source}</code>
              </pre>
            </li>
          ))}
        </ul>
        {context.dependencies.length > 0 && (
          <>
            <h4>Verified dependencies</h4>
            <ul className="assistant-dependencies">
              {context.dependencies.map((edge, index) => (
                <li key={index}>
                  <code>{edge.source}</code> imports <code>{edge.target}</code>{' '}
                  <span>· {edge.evidence}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

function Answer({ turn, onOpen }: { turn: Turn; onOpen: (file: FileSelection) => void }) {
  const citations = turn.status === 'done' ? (turn.citations ?? []) : [];
  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  return (
    <section className="assistant-answer" aria-label="Assistant response">
      <h3>Assistant</h3>
      {turn.text && (
        <p className="assistant-answer-text">
          {citations.length === 0
            ? turn.text
            : turn.text.split(/(\[S\d+\])/gu).map((piece, index) => {
                const citation = piece.startsWith('[') ? byId.get(piece.slice(1, -1)) : undefined;
                return citation ? (
                  <button
                    key={index}
                    className="citation-marker"
                    type="button"
                    onClick={() => onOpen(sourceSelection(citation))}
                  >
                    {referenceLabel(citation)}
                  </button>
                ) : (
                  piece
                );
              })}
        </p>
      )}
      {turn.status === 'streaming' && (
        <p className="assistant-answer-status" role="status">
          Generating a response…
        </p>
      )}
      {turn.status === 'stopped' && (
        <p className="assistant-answer-status" role="status">
          Response stopped.
        </p>
      )}
      {turn.status === 'done' &&
        (citations.length === 0 && Boolean(turn.context?.excerpts.length) ? (
          <p className="assistant-answer-status" role="status">
            The model did not cite the provided excerpts.
          </p>
        ) : (
          <span className="sr-only" role="status">
            Response ready.
          </span>
        ))}
      {turn.status === 'error' && turn.error && <ErrorNotice message={turn.error} />}
      {turn.context && <ContextDetails context={turn.context} onOpen={onOpen} />}
    </section>
  );
}

export function RepositoryChat({
  active,
  analysis,
  settings,
  destination,
  settingsRevision,
  connectionRevision,
  onOpen,
}: {
  active: boolean;
  analysis: ProjectAnalysis | undefined;
  settings: AISettings;
  destination: Destination | undefined;
  settingsRevision: number;
  connectionRevision: number;
  onOpen: (file: FileSelection) => void;
}) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<Request['mode']>();
  const [preview, setPreview] = useState<{ signature: string; context: RepositoryContext }>();
  const [previewError, setPreviewError] = useState<string>();
  const request = useRef<Request | undefined>(undefined);
  const turnNumber = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const previousQuestions = turns
    .filter((turn) => turn.status === 'done' && turn.connection === connectionRevision)
    .slice(-repositoryAiLimits.maxPriorQuestions)
    .map((turn) => turn.question);
  const contextWindow = Number(settings.contextWindow);
  const validWindow =
    Number.isInteger(contextWindow) &&
    contextWindow >= repositoryAiLimits.minContextWindow &&
    contextWindow <= repositoryAiLimits.maxContextWindow;
  const contextInput = {
    enabled: true,
    question: question.trim(),
    priorQuestions: previousQuestions,
    contextWindow,
  };
  const signature = JSON.stringify(contextInput);
  const canPreview =
    settings.enabled &&
    Boolean(analysis?.files.length) &&
    Boolean(contextInput.question) &&
    validWindow;
  const canAsk =
    canPreview &&
    Boolean(settings.model.trim()) &&
    destination &&
    (!destination.requiresSourceConsent || consent);

  const stop = useCallback(() => {
    const pending = request.current;
    if (!pending) return;
    request.current = undefined;
    pending.abort.abort();
    setBusy(undefined);
    if (pending.mode === 'ask') {
      setTurns((items) =>
        items.map((turn) => (turn.id === pending.turnId ? { ...turn, status: 'stopped' } : turn)),
      );
    }
  }, []);

  useLayoutEffect(() => {
    stop();
    setConsent(false);
  }, [active, settingsRevision, stop]);

  useLayoutEffect(
    () => () => {
      request.current?.abort.abort();
      request.current = undefined;
    },
    [],
  );

  useLayoutEffect(() => {
    const region = transcript.current;
    if (active && region && followTranscript.current) region.scrollTop = region.scrollHeight;
  }, [active, turns]);

  function editQuestion(value: string) {
    if (request.current?.mode === 'preview') stop();
    setQuestion(value);
    setConsent(false);
    setPreviewError(undefined);
  }

  async function inspect() {
    if (!active || !analysis || !canPreview || request.current) return;
    const abort = new AbortController();
    request.current = { mode: 'preview', abort };
    setBusy('preview');
    setPreviewError(undefined);
    try {
      const context = await api<RepositoryContext>(
        `${projectRoute(analysis.project.id)}/ai-context`,
        post(contextInput, abort.signal),
      );
      if (!abort.signal.aborted) setPreview({ signature, context });
    } catch (cause) {
      if (!abort.signal.aborted) setPreviewError(errorMessage(cause));
    } finally {
      if (request.current?.abort === abort) {
        request.current = undefined;
        setBusy(undefined);
      }
    }
  }

  async function ask() {
    if (!active || !analysis || !destination || !canAsk || request.current) return;
    const abort = new AbortController();
    const turnId = ++turnNumber.current;
    request.current = { mode: 'ask', turnId, abort };
    setBusy('ask');
    setConsent(false);
    setQuestion('');
    setPreviewError(undefined);
    followTranscript.current = true;
    setTurns((items) => [
      ...items.slice(-(retainedTurns - 1)),
      {
        id: turnId,
        connection: connectionRevision,
        question: contextInput.question,
        text: '',
        status: 'streaming',
      },
    ]);

    function updateTurn(change: (turn: Turn) => Turn) {
      if (abort.signal.aborted) return;
      setTurns((items) => items.map((item) => (item.id === turnId ? change(item) : item)));
    }

    try {
      await streamRepositoryAnswer(
        `${projectRoute(analysis.project.id)}/ask`,
        {
          ...contextInput,
          ...providerConnection(settings),
          model: settings.model.trim(),
          consent: (!destination.local || destination.ollamaRelay) && consent,
        },
        abort.signal,
        (event) => {
          switch (event.type) {
            case 'context':
              updateTurn((turn) => ({ ...turn, context: event.context }));
              break;
            case 'delta':
              updateTurn((turn) => ({ ...turn, text: turn.text + event.text }));
              break;
            case 'done':
              updateTurn((turn) => ({
                ...turn,
                status: 'done',
                text: event.text,
                citations: event.citations,
              }));
              break;
            case 'error':
              updateTurn((turn) => ({ ...turn, status: 'error', error: event.message }));
              break;
          }
        },
      );
    } catch (cause) {
      updateTurn((turn) => ({ ...turn, status: 'error', error: errorMessage(cause) }));
    } finally {
      if (request.current?.abort === abort) {
        request.current = undefined;
        setBusy(undefined);
      }
    }
  }

  return (
    <section className="panel settings-panel assistant-chat" aria-labelledby="ask-title">
      <header className="assistant-chat-header">
        <h2 id="ask-title">
          <MessageSquare size={17} aria-hidden="true" /> Repository chat
        </h2>
        {turns.length > 0 && (
          <button
            className="button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => {
              setTurns([]);
              setPreview(undefined);
            }}
          >
            Clear chat
          </button>
        )}
      </header>
      {!analysis?.files.length ? (
        <p>Open a repository with source files to ask a question.</p>
      ) : (
        <>
          {turns.length === 0 ? (
            <div className="assistant-prompts" aria-label="Example questions">
              <p>Example questions</p>
              {exampleQuestions.map((example) => (
                <button
                  key={example}
                  className="button"
                  type="button"
                  disabled={!settings.enabled}
                  onClick={() => {
                    editQuestion(example);
                    input.current?.focus();
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          ) : (
            <div
              className="assistant-transcript"
              ref={transcript}
              role="region"
              aria-label="Repository conversation"
              tabIndex={0}
              onScroll={(event) => {
                const region = event.currentTarget;
                followTranscript.current =
                  region.scrollHeight - region.scrollTop - region.clientHeight < 90;
              }}
            >
              <ol>
                {turns.map((turn) => (
                  <li key={turn.id}>
                    <p className="assistant-question">{turn.question}</p>
                    <Answer turn={turn} onOpen={onOpen} />
                  </li>
                ))}
              </ol>
            </div>
          )}
          {turns.length === retainedTurns && (
            <p className="field-hint">The chat keeps the most recent {retainedTurns} turns.</p>
          )}
          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <label htmlFor="repository-question">Repository question</label>
            <textarea
              id="repository-question"
              ref={input}
              rows={3}
              maxLength={repositoryAiLimits.maxQuestionLength}
              value={question}
              disabled={!settings.enabled}
              onChange={(event) => editQuestion(event.target.value)}
              placeholder="Ask about files, entry points, or module relationships"
            />
            {settings.enabled && (
              <SourceConsent
                destination={destination}
                scope="response"
                checked={consent}
                onChecked={setConsent}
              />
            )}
            <div className="assistant-actions">
              <button className="button primary" type="submit" disabled={!canAsk || Boolean(busy)}>
                <Send size={16} aria-hidden="true" /> Send question
              </button>
              {busy === 'ask' ? (
                <button className="button" type="button" onClick={stop}>
                  <Square size={14} aria-hidden="true" /> Stop response
                </button>
              ) : (
                <button
                  className="button"
                  type="button"
                  disabled={!canPreview || Boolean(busy)}
                  onClick={() => {
                    void inspect();
                  }}
                >
                  <Braces size={16} aria-hidden="true" /> Preview context
                </button>
              )}
            </div>
            {!settings.enabled && (
              <p className="field-hint">
                Enable the assistant in this workspace to ask a question.
              </p>
            )}
            {settings.enabled && !settings.model.trim() && (
              <p className="field-hint">
                Choose a model in{' '}
                <a className="assistant-settings-link" href="#ai-model">
                  provider settings
                </a>{' '}
                to send a question.
              </p>
            )}
            {settings.enabled && !validWindow && (
              <p className="field-hint">Enter a context window from 2,048 to 32,768 tokens.</p>
            )}
            {busy === 'preview' && (
              <p className="field-hint" role="status">
                Selecting context locally…
              </p>
            )}
          </form>
          {previewError && <ErrorNotice message={previewError} />}
          {preview?.signature === signature && (
            <ContextDetails context={preview.context} onOpen={onOpen} initiallyOpen />
          )}
        </>
      )}
    </section>
  );
}
