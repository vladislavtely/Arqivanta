import { useEffect, useState } from 'react';
import type { FlowAnchor, ProjectAnalysis, ProjectSummary } from '@arqivanta/shared';
import {
  Box,
  Download,
  FolderOpen,
  LayoutGrid,
  LockKeyhole,
  Network,
  Route,
  Sparkles,
} from 'lucide-react';
import { api, errorMessage, post, projectRoute } from './api';
import { AI } from './components/AI';
import type { AssistantView } from './components/AI';
import { connectionChanged, initialAISettings } from './components/ai-settings';
import type { AISettings } from './components/ai-settings';
import { Architecture } from './components/Architecture';
import { CodeRoutes } from './components/CodeRoutes';
import { Explorer } from './components/Explorer';
import type { FileSelection } from './components/Explorer';
import { Export } from './components/Export';
import { Home } from './components/Home';
import type { ProjectInput } from './components/Home';
import { NoProject } from './components/ui';

const navigation = [
  { id: 'home', label: 'Overview', Icon: LayoutGrid },
  { id: 'explorer', label: 'Repository Explorer', Icon: FolderOpen },
  { id: 'graph', label: 'Architecture Map', Icon: Network },
  { id: 'routes', label: 'Code Routes', Icon: Route },
  { id: 'ai', label: 'Repository AI Assistant', Icon: Sparkles },
  { id: 'export', label: 'Export Center', Icon: Download },
] as const;

type View = (typeof navigation)[number]['id'];

export function App() {
  const [view, setView] = useState<View>('home');
  const [analysis, setAnalysis] = useState<ProjectAnalysis>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [canBrowseFolders, setCanBrowseFolders] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selection, setSelection] = useState<FileSelection>();
  const [traceStart, setTraceStart] = useState<FlowAnchor>();
  const [routesOpened, setRoutesOpened] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [assistantView, setAssistantView] = useState<AssistantView>('ask');
  const [ai, setAI] = useState({ settings: initialAISettings, revision: 0, connection: 0 });
  const title = navigation.find((item) => item.id === view)?.label ?? 'Overview';

  useEffect(() => {
    const abort = new AbortController();
    void api<{ folderPicker: boolean }>('/health', { signal: abort.signal }).then(
      ({ folderPicker }) => {
        if (!abort.signal.aborted) setCanBrowseFolders(folderPicker === true);
      },
      () => {},
    );
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void api<ProjectSummary[]>('/projects', { signal: abort.signal }).then(
      (items) => {
        if (abort.signal.aborted) return;
        setProjects(items);
        setHistoryError(null);
      },
      (cause: unknown) => {
        if (!abort.signal.aborted) setHistoryError(errorMessage(cause));
      },
    );
    return () => abort.abort();
  }, [analysis]);

  useEffect(() => {
    document.title = view === 'home' ? 'Arqivanta' : `${title} · Arqivanta`;
  }, [title, view]);

  async function openProject(route: string, loading: string, data?: ProjectInput) {
    if (pending || refreshing) return;
    setPending(loading);
    setError(null);
    try {
      const result = await api<ProjectAnalysis | null>(route, data ? post(data) : undefined);
      if (result === null) return;
      const entry = result.entryPoints.find((point) =>
        result.files.some((file) => file.path === point.path),
      );
      const path = entry?.path ?? result.files[0]?.path;
      setAnalysis(result);
      setTraceStart(undefined);
      setRoutesOpened(false);
      setRefreshError(null);
      setSelection(path ? { path } : undefined);
      setView('explorer');
    } catch (cause) {
      setError(errorMessage(cause));
      setView('home');
    } finally {
      setPending(null);
    }
  }

  function openFile(file: FileSelection) {
    setSelection(file);
    setView('explorer');
  }

  function openRoutes(anchor?: FlowAnchor) {
    if (anchor) setTraceStart(anchor);
    setRoutesOpened(true);
    setView('routes');
  }

  async function refreshSnapshot() {
    if (!analysis || refreshing || pending) return;
    const previous = analysis;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const current = await api<ProjectAnalysis>(
        `${projectRoute(previous.project.id)}/refresh`,
        post({}),
      );
      setAnalysis(current);
      setTraceStart((anchor) =>
        current.files.some(
          ({ path, flow }) => path === anchor?.path && flow?.some(({ key }) => key === anchor.key),
        )
          ? anchor
          : undefined,
      );
      setSelection((active) => {
        if (active && current.files.some((file) => file.path === active.path))
          return { path: active.path };
        const path = current.entryPoints[0]?.path ?? current.files[0]?.path;
        return path ? { path } : undefined;
      });
    } catch (cause) {
      setRefreshError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  }

  function updateAISettings(settings: AISettings) {
    setAI((previous) => ({
      settings,
      revision: previous.revision + 1,
      connection: previous.connection + Number(connectionChanged(previous.settings, settings)),
    }));
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Arqivanta workspace">
        <button className="brand" type="button" onClick={() => setView('home')}>
          <span className="brand-mark">
            <Box size={20} strokeWidth={2} aria-hidden="true" />
          </span>
          <span>Arqivanta</span>
        </button>
        <nav className="main-nav" aria-label="Workspace navigation">
          {navigation.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={id === view ? 'page' : undefined}
              onClick={() => (id === 'routes' ? openRoutes() : setView(id))}
              title={label}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {analysis && (
          <div className="sidebar-project">
            <span>Current repository</span>
            <button
              className="current-project"
              type="button"
              title={analysis.project.name}
              aria-label={`Open ${analysis.project.name} in Repository Explorer`}
              onClick={() => setView('explorer')}
            >
              <span className="current-project-icon">
                <FolderOpen size={15} aria-hidden="true" />
              </span>
              <span>{analysis.project.name}</span>
            </button>
          </div>
        )}
        <div className="sidebar-footer">
          <LockKeyhole size={15} aria-hidden="true" />
          <span>Local workspace</span>
        </div>
      </aside>
      <div className="app-content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <strong>{title}</strong>
          </div>
          {analysis?.project.commitSha && (
            <span className="commit-indicator" title={analysis.project.commitSha}>
              Commit {analysis.project.commitSha.slice(0, 7)}
            </span>
          )}
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {view === 'home' && (
            <Home
              projects={projects}
              canBrowseFolders={canBrowseFolders}
              pending={pending}
              error={error ?? historyError}
              onImport={(data, message) => {
                void openProject('/projects', message, data);
              }}
              onOpen={(project) => {
                void openProject(projectRoute(project.id), 'Opening saved project…');
              }}
            />
          )}
          <div hidden={view !== 'ai'}>
            <AI
              key={analysis?.project.id}
              active={view === 'ai'}
              view={assistantView}
              onView={setAssistantView}
              analysis={analysis}
              selection={selection}
              settings={ai.settings}
              settingsRevision={ai.revision}
              connectionRevision={ai.connection}
              onSettings={updateAISettings}
              onSelect={setSelection}
              onOpen={openFile}
            />
          </div>
          {view !== 'home' && view !== 'ai' && !analysis && (
            <NoProject onOpen={() => setView('home')} />
          )}
          {view === 'explorer' && analysis && (
            <Explorer
              key={analysis.project.id}
              analysis={analysis}
              selection={selection}
              onSelect={setSelection}
              onExplain={() => {
                setAssistantView('explain');
                setView('ai');
              }}
              onTrace={openRoutes}
            />
          )}
          {routesOpened && analysis && (
            <div hidden={view !== 'routes'}>
              <CodeRoutes
                analysis={analysis}
                initial={traceStart}
                refreshing={refreshing}
                refreshError={refreshError}
                onRefresh={() => void refreshSnapshot()}
                onOpen={openFile}
              />
            </div>
          )}
          {view === 'graph' && analysis && (
            <Architecture
              key={analysis.project.id}
              analysis={analysis}
              selected={selection?.path}
              onSelect={setSelection}
              onOpenFile={openFile}
            />
          )}
          {view === 'export' && analysis && <Export analysis={analysis} />}
        </main>
      </div>
    </div>
  );
}
