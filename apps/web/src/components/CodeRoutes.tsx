import { useEffect, useMemo, useRef, useState } from 'react';
import { GitCompareArrows, Route } from 'lucide-react';
import type {
  CodeTrace,
  FlowAnchor,
  ImpactItem,
  ProjectAnalysis,
  ProjectSummary,
  SavedTrace,
  SavedTraceReview,
  SnapshotComparison,
  SourceRef,
} from '@arqivanta/shared';
import { isPythonSource } from '@arqivanta/shared';
import { api, errorMessage, post, projectRoute } from '../api';
import { referenceLabel } from './ai-settings';
import type { FileSelection } from './Explorer';
import { ErrorNotice, Loading, plural } from './ui';

type OpenSource = (reference: SourceRef, snapshotId: string) => void;
type HistoricalReference = { reference: SourceRef; snapshotId: string };

function SourceButton({
  reference,
  label,
  onOpen,
}: {
  reference: SourceRef;
  label?: string;
  onOpen: (reference: SourceRef) => void;
}) {
  return (
    <button className="text-button route-reference" type="button" onClick={() => onOpen(reference)}>
      {label && <span>{label} </span>}
      {referenceLabel(reference)}
    </button>
  );
}

function HistoricalSource({ item, onClose }: { item: HistoricalReference; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const { reference, snapshotId } = item;
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    const query = new URLSearchParams({ path: reference.path });
    void api<{ content: string }>(`${projectRoute(snapshotId)}/source?${query}`, {
      signal: controller.signal,
    }).then(
      ({ content }) => {
        if (!controller.signal.aborted) setContent(content);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setFailure(errorMessage(cause));
      },
    );
    return () => controller.abort();
  }, [reference.path, snapshotId]);
  const first = Math.max(1, reference.startLine - 3);
  const last = Math.min(reference.endLine + 3, first + 499);
  const lines = content?.split(
    isPythonSource(reference.path) ? /\r\n|[\r\n]/u : /\r\n|[\r\n\u2028\u2029]/u,
  );
  return (
    <dialog
      className="historical-source panel"
      ref={dialog}
      onClose={onClose}
      aria-labelledby="historical-source-title"
    >
      <header>
        <h2 id="historical-source-title">Snapshot source</h2>
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Close source
        </button>
      </header>
      <p>
        <code>{referenceLabel(reference)}</code>
      </p>
      {failure ? (
        <ErrorNotice message={failure} />
      ) : lines ? (
        <div className="code-lines" role="region" aria-label="Snapshot source code" tabIndex={0}>
          {lines.slice(first - 1, last).map((line, index) => {
            const number = first + index;
            const selected = number >= reference.startLine && number <= reference.endLine;
            return (
              <div key={number} className={`code-line${selected ? ' active' : ''}`}>
                <span className="historical-line-number">{number}</span>
                <code>{line || ' '}</code>
              </div>
            );
          })}
        </div>
      ) : (
        <Loading>Reading snapshot source…</Loading>
      )}
      {reference.endLine > last && <p>The preview shows the first 500 lines of this range.</p>}
    </dialog>
  );
}

const stepStates = {
  entry: 'Entry point',
  resolved: 'Direct reference',
  revisited: 'Already shown',
  unresolved: 'Target unresolved',
};

function TraceSteps({
  trace,
  onOpen,
  changes,
  canOpen,
  onUpdate,
}: {
  trace: CodeTrace;
  onOpen: (reference: SourceRef, stepId: string) => void;
  changes?: Map<string, SavedTraceReview['changes'][number]['status']>;
  canOpen: (stepId: string) => boolean;
  onUpdate?: (stepId: string) => void;
}) {
  const [showUnresolved, setShowUnresolved] = useState(true);
  const unresolved = trace.steps.some(({ state }) => state === 'unresolved');
  return (
    <>
      {unresolved && (
        <label className="consent-control route-filter">
          <input
            type="checkbox"
            checked={showUnresolved}
            onChange={(event) => setShowUnresolved(event.target.checked)}
          />
          Show unresolved calls
        </label>
      )}
      <ol className="route-steps" aria-label="Trace steps">
        {trace.steps
          .filter((step) => showUnresolved || step.state !== 'unresolved')
          .map((step) => {
            const change = changes?.get(step.id);
            const distinctDefinition =
              step.definition && referenceLabel(step.definition) !== referenceLabel(step.evidence);
            return (
              <li
                key={step.id}
                style={{ marginInlineStart: `${Math.min(step.depth, 5) * 0.68}rem` }}
              >
                <div className="route-step-heading">
                  <code>{step.label}</code>
                  <span className={`route-status ${change ?? step.state}`}>
                    {change ?? stepStates[step.state]}
                  </span>
                </div>
                {canOpen(step.id) ? (
                  <div className="route-step-links">
                    <SourceButton
                      reference={step.evidence}
                      onOpen={(ref) => onOpen(ref, step.id)}
                    />
                    {distinctDefinition && (
                      <SourceButton
                        reference={step.definition!}
                        label="Definition"
                        onOpen={(ref) => onOpen(ref, step.id)}
                      />
                    )}
                    {change === 'changed' && onUpdate && (
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`Update saved step ${step.label}`}
                        onClick={() => onUpdate(step.id)}
                      >
                        Update saved step
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="field-hint">The source snapshot for this step has expired.</p>
                )}
              </li>
            );
          })}
      </ol>
      {trace.limited && (
        <p className="field-hint">
          This trace reached the depth or step limit. Open a definition to continue from there.
        </p>
      )}
    </>
  );
}

function TraceExplorer({
  analysis,
  initial,
  onOpen,
}: {
  analysis: ProjectAnalysis;
  initial?: FlowAnchor;
  onOpen: OpenSource;
}) {
  const id = analysis.project.id;
  const [filter, setFilter] = useState(initial?.path ?? '');
  const [anchor, setAnchor] = useState(initial);
  const [trace, setTrace] = useState<CodeTrace>();
  const [saved, setSaved] = useState<SavedTrace[]>([]);
  const [review, setReview] = useState<SavedTraceReview>();
  const [reviewId, setReviewId] = useState('');
  const [prior, setPrior] = useState(false);
  const [title, setTitle] = useState('');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(60);
  const request = useRef<AbortController | undefined>(undefined);
  const definitions = useMemo(
    () =>
      analysis.files
        .flatMap(({ flow }) => flow ?? [])
        .sort(
          (a, b) =>
            Number(b.kind === 'http') - Number(a.kind === 'http') ||
            a.path.localeCompare(b.path) ||
            a.startLine - b.startLine,
        ),
    [analysis.files],
  );
  const matches = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/u);
    return definitions.filter(({ label, path }) =>
      terms.every((term) => `${label} ${path}`.toLowerCase().includes(term)),
    );
  }, [definitions, filter]);

  useEffect(() => {
    const controller = new AbortController();
    void api<SavedTrace[]>(`${projectRoute(id)}/traces`, { signal: controller.signal }).then(
      (items) => {
        if (!controller.signal.aborted) setSaved(items);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setFailure(errorMessage(cause));
      },
    );
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [id]);

  useEffect(() => {
    if ((!anchor && !reviewId) || (anchor && reviewId)) return;
    const controller = new AbortController();
    request.current = controller;
    if (reviewId) {
      void api<SavedTraceReview>(`${projectRoute(id)}/traces/${reviewId}`, {
        signal: controller.signal,
      }).then(
        (result) => {
          if (!controller.signal.aborted) setReview(result);
        },
        (cause: unknown) => {
          if (!controller.signal.aborted) setFailure(errorMessage(cause));
        },
      );
    } else if (anchor) {
      const query = new URLSearchParams({ path: anchor.path, key: anchor.key });
      void api<CodeTrace>(`${projectRoute(id)}/trace?${query}`, { signal: controller.signal }).then(
        (result) => {
          if (!controller.signal.aborted) setTrace(result);
        },
        (cause: unknown) => {
          if (!controller.signal.aborted) setFailure(errorMessage(cause));
        },
      );
    }
    return () => controller.abort();
  }, [anchor, id, reviewId]);

  function selectAnchor(anchor: FlowAnchor) {
    setFailure('');
    setNotice('');
    setTrace(undefined);
    setReview(undefined);
    setPrior(false);
    setReviewId('');
    setAnchor({ ...anchor });
    setTitle('');
  }

  function selectSaved(savedId: string) {
    setFailure('');
    setNotice('');
    setTrace(undefined);
    setReview(undefined);
    setPrior(false);
    setAnchor(undefined);
    setReviewId(savedId);
  }

  async function save(mode: 'new' | 'update' | 'remove', stepId?: string) {
    if (busy) return;
    setBusy(true);
    setFailure('');
    setNotice('');
    const controller = new AbortController();
    request.current = controller;
    const base = `${projectRoute(id)}/traces`;
    try {
      if (mode === 'new' && trace) {
        const result = await api<SavedTrace>(
          base,
          post({ ...trace.anchor, title: title.trim() || trace.label }, controller.signal),
        );
        if (controller.signal.aborted) return;
        setSaved((items) => [result, ...items]);
        setNotice('Trace saved.');
      } else if (review && mode === 'update') {
        const result = await api<SavedTraceReview>(
          `${base}/${review.saved.id}`,
          post({ stepId }, controller.signal),
        );
        if (controller.signal.aborted) return;
        setSaved((items) =>
          items.map((item) => (item.id === result.saved.id ? result.saved : item)),
        );
        setReview(result);
        setPrior(false);
        setNotice(stepId ? 'Saved step updated.' : 'Saved trace updated.');
      } else if (review && mode === 'remove') {
        await api(`${base}/${review.saved.id}`, { method: 'DELETE', signal: controller.signal });
        if (controller.signal.aborted) return;
        setSaved((items) => items.filter((item) => item.id !== review.saved.id));
        selectSaved('');
        setNotice('Saved trace removed.');
      }
    } catch (cause) {
      if (!controller.signal.aborted) setFailure(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const selectedTrace = review ? (prior ? review.saved.trace : review.current) : trace;
  const displayedSnapshot = prior && review ? review.saved.snapshotId : id;
  function snapshotForStep(stepId: string) {
    return prior && review ? (review.saved.stepSnapshots?.[stepId] ?? displayedSnapshot) : id;
  }
  const changes = review && new Map(review.changes.map(({ id, status }) => [id, status]));
  return (
    <div className="route-layout">
      <section className="panel route-panel" aria-labelledby="trace-start-title">
        <h2 id="trace-start-title">Start a trace</h2>
        <label htmlFor="route-search">Find routes or functions</label>
        <input
          id="route-search"
          type="search"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setMore(60);
          }}
        />
        <ul className="route-choices">
          {matches.slice(0, more).map(({ key, path, label, kind }) => (
            <li key={JSON.stringify([path, key])}>
              <button
                className="button"
                type="button"
                aria-pressed={anchor?.path === path && anchor.key === key}
                disabled={busy}
                onClick={() => selectAnchor({ path, key })}
              >
                <strong>{label}</strong>
                <small>
                  {kind === 'http' ? 'HTTP · ' : ''}
                  {path}
                </small>
              </button>
            </li>
          ))}
        </ul>
        {!matches.length && (
          <p>
            {definitions.length
              ? 'No matching routes or functions.'
              : 'No traceable definitions in this snapshot. Analyze the project again if it predates Code Routes.'}
          </p>
        )}
        {matches.length > more && (
          <button type="button" className="button" onClick={() => setMore(more + 60)}>
            Show more results
          </button>
        )}
        {saved.length > 0 && (
          <>
            <h3>Saved traces</h3>
            <ul className="route-saved">
              {saved.map((item) => (
                <li key={item.id}>
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    aria-pressed={reviewId === item.id}
                    onClick={() => {
                      if (reviewId !== item.id) selectSaved(item.id);
                    }}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className="panel route-panel" aria-labelledby="trace-detail-title">
        <h2 id="trace-detail-title">{review?.saved.title ?? trace?.label ?? 'Code trace'}</h2>
        {failure && <ErrorNotice message={failure} />}
        {notice && <p role="status">{notice}</p>}
        {review && (
          <>
            <p>
              {review.changes.filter(({ status }) => status === 'changed').length} changed ·{' '}
              {review.changes.filter(({ status }) => status === 'added').length} added ·{' '}
              {review.changes.filter(({ status }) => status === 'removed').length} removed
            </p>
            <div className="route-actions">
              <button
                type="button"
                className="button"
                aria-pressed={!prior}
                onClick={() => setPrior(false)}
              >
                Current trace
              </button>
              <button
                type="button"
                className="button"
                aria-pressed={prior}
                disabled={!review.previousAvailable}
                onClick={() => setPrior(true)}
              >
                Saved trace
              </button>
              <button
                type="button"
                className="button"
                disabled={busy || !review.current || review.saved.snapshotId === id}
                onClick={() => void save('update')}
              >
                Update saved trace
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void save('remove')}
              >
                Remove saved trace
              </button>
            </div>
            {!review.previousAvailable && (
              <p className="field-hint">The original source snapshot has expired.</p>
            )}
          </>
        )}
        {selectedTrace ? (
          <TraceSteps
            key={JSON.stringify([displayedSnapshot, selectedTrace.anchor])}
            trace={selectedTrace}
            changes={changes}
            onOpen={(ref, stepId) => onOpen(ref, snapshotForStep(stepId))}
            canOpen={(stepId) =>
              !prior || Boolean(review?.availableSnapshots.includes(snapshotForStep(stepId)))
            }
            onUpdate={
              !prior && review && !busy ? (stepId) => void save('update', stepId) : undefined
            }
          />
        ) : review ? (
          <p>The starting route or function is absent from this snapshot.</p>
        ) : (anchor || reviewId) && !failure ? (
          <Loading>Building code trace…</Loading>
        ) : (
          !failure && <p>Select a route or function to follow its direct calls.</p>
        )}
        {trace && (
          <form
            className="route-save"
            onSubmit={(event) => {
              event.preventDefault();
              void save('new');
            }}
          >
            <label htmlFor="trace-title">Trace name</label>
            <input
              id="trace-title"
              value={title}
              placeholder={trace.label}
              maxLength={100}
              onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" className="button primary" disabled={busy}>
              Save trace
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

function ImpactList({ items, onOpen }: { items: ImpactItem[]; onOpen: OpenSource }) {
  return (
    <ul className="impact-list">
      {items.map((item, index) => (
        <li key={index}>
          <details>
            <summary>
              {item.label && (
                <>
                  <strong>{item.label}</strong> ·{' '}
                </>
              )}
              <code>{item.path}</code> · {item.distance === 1 ? 'direct' : `${item.distance} hops`}
              {item.test ? ' · test' : ''}
            </summary>
            <ol>
              {item.chain.map((ref, index) => (
                <li key={index}>
                  <SourceButton reference={ref} onOpen={(ref) => onOpen(ref, item.snapshotId)} />
                </li>
              ))}
            </ol>
          </details>
        </li>
      ))}
    </ul>
  );
}

function CompareChanges({ project, onOpen }: { project: ProjectSummary; onOpen: OpenSource }) {
  const [baselines, setBaselines] = useState<ProjectSummary[]>([]);
  const [baseline, setBaseline] = useState('');
  const [result, setResult] = useState<SnapshotComparison>();
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [testsOnly, setTestsOnly] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const base = projectRoute(project.id);
  useEffect(() => {
    const controller = new AbortController();
    void api<ProjectSummary[]>(`${base}/baselines`, { signal: controller.signal }).then(
      (items) => {
        if (!controller.signal.aborted) {
          setBaselines(items);
          setBaseline(items[0]?.id ?? '');
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setFailure(errorMessage(cause));
      },
    );
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [base]);
  async function compare(head: boolean) {
    if (busy) return;
    setBusy(true);
    setFailure('');
    setResult(undefined);
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = head
        ? await api<SnapshotComparison>(`${base}/compare-head`, post({}, controller.signal))
        : await api<SnapshotComparison>(`${base}/compare?${new URLSearchParams({ baseline })}`, {
            signal: controller.signal,
          });
      if (!controller.signal.aborted) setResult(result);
    } catch (cause) {
      if (!controller.signal.aborted) setFailure(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="panel route-panel" aria-labelledby="compare-title">
      <h2 id="compare-title">Change impact</h2>
      <p>
        Compare the open snapshot with an earlier snapshot or Git HEAD. Refresh the snapshot to
        include recent working folder edits.
      </p>
      <div className="route-actions compare-controls">
        <div>
          <label htmlFor="baseline-snapshot">Earlier snapshot</label>
          <select
            id="baseline-snapshot"
            value={baseline}
            onChange={(event) => setBaseline(event.target.value)}
          >
            {!baselines.length && <option value="">No earlier snapshots</option>}
            {baselines.map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.createdAt).toLocaleString()} ·{' '}
                {item.commitSha?.slice(0, 7) ?? item.id.slice(0, 7)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy || !baseline}
          onClick={() => void compare(false)}
        >
          Compare snapshots
        </button>
        {project.canRefresh && (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void compare(true)}
          >
            Compare with Git HEAD
          </button>
        )}
      </div>
      {busy && <Loading>Comparing snapshots…</Loading>}
      {failure && <ErrorNotice message={failure} />}
      {result && (
        <div className="compare-results">
          <h3>Snapshot differences</h3>
          <p>
            {result.fileCounts.added} added · {result.fileCounts.changed} modified ·{' '}
            {result.fileCounts.removed} removed files
          </p>
          <p>
            {result.dependencyCounts.added} added · {result.dependencyCounts.removed} removed import
            links
          </p>
          {result.limited && (
            <p className="field-hint">Some results are beyond the display or graph depth limit.</p>
          )}
          {result.files.length > 0 && (
            <details>
              <summary>Changed files</summary>
              <ul>
                {result.files.map(({ path, status }) => (
                  <li key={path}>
                    <span className={`route-status ${status}`}>{status}</span>{' '}
                    <SourceButton
                      reference={{ path, startLine: 1, endLine: 1 }}
                      onOpen={(ref) =>
                        onOpen(ref, status === 'removed' ? result.baseline.id : result.current.id)
                      }
                    />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.dependencies.length > 0 && (
            <details>
              <summary>Changed import links</summary>
              <ul>
                {result.dependencies.map(({ edge, status }) => (
                  <li key={JSON.stringify([status, edge.source, edge.target])}>
                    <span className={`route-status ${status}`}>{status}</span>{' '}
                    <code>
                      {edge.source} → {edge.target}
                    </code>{' '}
                    {edge.references[0] && (
                      <SourceButton
                        reference={edge.references[0]}
                        label="Import"
                        onOpen={(ref) =>
                          onOpen(ref, status === 'removed' ? result.baseline.id : result.current.id)
                        }
                      />
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.definitions.length > 0 && (
            <details>
              <summary>Changed functions and routes</summary>
              <p>
                {result.definitionCounts.added} added · {result.definitionCounts.changed} modified ·{' '}
                {result.definitionCounts.removed} removed
              </p>
              <ul>
                {result.definitions.map(({ label, reference, status }, index) => (
                  <li key={index}>
                    <span className={`route-status ${status}`}>{status}</span>{' '}
                    <SourceButton
                      reference={reference}
                      label={label}
                      onOpen={(ref) =>
                        onOpen(ref, status === 'removed' ? result.baseline.id : result.current.id)
                      }
                    />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.callImpact.length > 0 && (
            <>
              <h3>Potentially affected callers</h3>
              <ImpactList items={result.callImpact} onOpen={onOpen} />
            </>
          )}
          <h3>Potentially affected importers</h3>
          {result.impact.length > 0 ? (
            <>
              <label className="consent-control route-filter">
                <input
                  type="checkbox"
                  checked={testsOnly}
                  onChange={(event) => setTestsOnly(event.target.checked)}
                />{' '}
                Show related tests only
              </label>
              <ImpactList
                items={result.impact.filter((item) => !testsOnly || item.test)}
                onOpen={onOpen}
              />
              {testsOnly && !result.impact.some((item) => item.test) && (
                <p>No test files found in these import chains.</p>
              )}
            </>
          ) : (
            <p>No importers reached by the analyzed changes.</p>
          )}
        </div>
      )}
    </section>
  );
}

export function CodeRoutes({
  analysis,
  initial,
  refreshing,
  refreshError,
  onRefresh,
  onOpen,
}: {
  analysis: ProjectAnalysis;
  initial?: FlowAnchor;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
  onOpen: (selection: FileSelection) => void;
}) {
  const [mode, setMode] = useState<'traces' | 'compare'>('traces');
  const [historical, setHistorical] = useState<HistoricalReference>();
  const id = analysis.project.id;
  const openSource: OpenSource = (reference, snapshotId) => {
    if (snapshotId !== id) setHistorical({ reference, snapshotId });
    else onOpen({ path: reference.path, line: reference.startLine, endLine: reference.endLine });
  };
  return (
    <div className="page workbench-page code-routes">
      <header className="workbench-header">
        <div>
          <h1>Code Routes</h1>
          <p>{analysis.project.name}</p>
        </div>
        {analysis.project.canRefresh && (
          <button type="button" className="button" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? 'Refreshing snapshot…' : 'Refresh snapshot'}
          </button>
        )}
      </header>
      {refreshError && <ErrorNotice message={refreshError} />}
      {analysis.analysisStats?.reused ? (
        <p className="field-hint" role="status">
          {plural(analysis.analysisStats.reused, 'file')} reused ·{' '}
          {plural(analysis.analysisStats.parsed, 'file')} parsed
        </p>
      ) : null}
      <nav className="route-actions" aria-label="Code Routes views">
        <button
          className="button"
          type="button"
          aria-pressed={mode === 'traces'}
          onClick={() => setMode('traces')}
        >
          <Route size={16} aria-hidden="true" /> Trace code
        </button>
        <button
          className="button"
          type="button"
          aria-pressed={mode === 'compare'}
          onClick={() => setMode('compare')}
        >
          <GitCompareArrows size={16} aria-hidden="true" /> Compare changes
        </button>
      </nav>
      {mode === 'traces' ? (
        <TraceExplorer
          key={JSON.stringify([id, initial])}
          analysis={analysis}
          initial={initial}
          onOpen={openSource}
        />
      ) : (
        <CompareChanges key={id} project={analysis.project} onOpen={openSource} />
      )}
      {historical && (
        <HistoricalSource
          key={JSON.stringify(historical)}
          item={historical}
          onClose={() => setHistorical(undefined)}
        />
      )}
    </div>
  );
}
