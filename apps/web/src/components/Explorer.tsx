import { useEffect, useMemo, useRef, useState } from 'react';
import type { Diagnostic, FileRecord, ProjectAnalysis } from '@arqivanta/shared';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  FileCode2,
  Folder,
  GitBranch,
  Search,
  Sparkles,
} from 'lucide-react';
import { api, errorMessage, projectRoute } from '../api';
import { ErrorNotice, Loading, fileName, plural } from './ui';

export type FileSelection = { path: string; line?: number; endLine?: number };

type Directory = {
  path: string;
  folders: Map<string, Directory>;
  files: FileRecord[];
};

const filesPerPage = 250;

function toTree(files: FileRecord[]): Directory {
  const root: Directory = { path: '', folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/').slice(0, -1);
    let current = root;
    for (const folder of parts) {
      let child = current.folders.get(folder);
      if (!child) {
        child = {
          path: current.path ? `${current.path}/${folder}` : folder,
          folders: new Map(),
          files: [],
        };
        current.folders.set(folder, child);
      }
      current = child;
    }
    current.files.push(file);
  }
  return root;
}

function TreeList({
  directory,
  depth,
  search,
  selected,
  toggles,
  onToggle,
  onSelect,
}: {
  directory: Directory;
  depth: number;
  search: boolean;
  selected: string | undefined;
  toggles: Record<string, boolean>;
  onToggle: (directoryPath: string, open: boolean) => void;
  onSelect: (selection: FileSelection) => void;
}) {
  return (
    <ul className="tree-list">
      {[...directory.folders].map(([name, child]) => {
        const open =
          search ||
          (Object.hasOwn(toggles, child.path)
            ? toggles[child.path]
            : depth === 0 || Boolean(selected?.startsWith(`${child.path}/`)));
        return (
          <li key={child.path}>
            <button
              type="button"
              className="tree-row folder-row"
              title={child.path}
              aria-expanded={open}
              onClick={() => onToggle(child.path, !open)}
              disabled={search}
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Folder size={15} /> <span>{name}</span>
            </button>
            {open && (
              <TreeList
                directory={child}
                depth={depth + 1}
                search={search}
                selected={selected}
                toggles={toggles}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
      {directory.files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            className="tree-row file-row"
            title={file.path}
            aria-label={file.path}
            aria-current={selected === file.path ? 'true' : undefined}
            onClick={() => onSelect({ path: file.path })}
          >
            <FileCode2 size={15} /> <span>{fileName(file.path)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: FileRecord[];
  selected: string | undefined;
  onSelect: (selection: FileSelection) => void;
}) {
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [pageOverride, setPageOverride] = useState<{
    query: string;
    selected?: string;
    page: number;
  }>();
  const search = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      search
        ? files.filter(
            (file) =>
              file.path.toLowerCase().includes(search) ||
              file.symbols.some((symbol) => symbol.name.toLowerCase().includes(search)) ||
              file.exports.some((item) => item.name.toLowerCase().includes(search)),
          )
        : files,
    [files, search],
  );
  const pageCount = Math.ceil(matches.length / filesPerPage);
  const selectedIndex = selected ? matches.findIndex((file) => file.path === selected) : -1;
  const selectedPage = selectedIndex < 0 ? 0 : Math.floor(selectedIndex / filesPerPage);
  const page =
    pageOverride?.query === search && pageOverride.selected === selected
      ? Math.min(pageOverride.page, Math.max(0, pageCount - 1))
      : selectedPage;
  const tree = useMemo(
    () => toTree(matches.slice(page * filesPerPage, (page + 1) * filesPerPage)),
    [matches, page],
  );
  const scroll = useRef<HTMLDivElement>(null);
  function changePage(nextPage: number) {
    setPageOverride({ query: search, selected, page: nextPage });
    scroll.current?.scrollTo(0, 0);
  }

  return (
    <nav className="explorer-tree" aria-label="Repository files">
      <header className="pane-heading">
        <h2>Files</h2>
        <span>{matches.length}</span>
      </header>
      <label className="search-field tree-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="Find files or symbols"
          placeholder="Find files or symbols"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="tree-scroll" ref={scroll}>
        {pageCount > 1 && (
          <div className="tree-pagination">
            <button
              className="button icon-button"
              type="button"
              aria-label="Previous file page"
              disabled={page === 0}
              onClick={() => changePage(page - 1)}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span aria-live="polite">
              Page {page + 1} of {pageCount}
            </span>
            <button
              className="button icon-button"
              type="button"
              aria-label="Next file page"
              disabled={page + 1 === pageCount}
              onClick={() => changePage(page + 1)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        {matches.length > 0 ? (
          <TreeList
            directory={tree}
            depth={0}
            search={Boolean(search)}
            selected={selected}
            toggles={toggles}
            onToggle={(path, open) => setToggles((previous) => ({ ...previous, [path]: open }))}
            onSelect={onSelect}
          />
        ) : (
          <p className="pane-empty">
            {search ? 'No matching files.' : 'No supported files were found.'}
          </p>
        )}
      </div>
    </nav>
  );
}

const linesPerPage = 400;
const tokenPattern =
  /(\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:abstract|as|async|await|break|case|catch|class|const|continue|declare|default|delete|else|enum|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|of|private|protected|public|readonly|return|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield)\b|\b\d+(?:\.\d+)?\b)/g;

const pythonTokenPattern =
  /(#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b|\b\d+(?:\.\d+)?\b)/g;

function codeTokens(line: string, language: string) {
  if (line.length > 4_000) return line;
  const parts = line.split(language === 'Python' ? pythonTokenPattern : tokenPattern);
  return parts.map((part, index) => {
    if (index % 2 === 0) return part;
    const kind =
      part.startsWith('//') || (language === 'Python' && part.startsWith('#'))
        ? 'comment'
        : ['"', "'", '`'].includes(part[0])
          ? 'string'
          : /\d/.test(part[0])
            ? 'number'
            : 'keyword';
    return (
      <span className={`token-${kind}`} key={index}>
        {part}
      </span>
    );
  });
}

function SourceCode({
  content,
  language,
  selection,
  onSelect,
}: {
  content: string;
  language: string;
  selection: FileSelection;
  onSelect: (selection: FileSelection) => void;
}) {
  const lines = useMemo(
    () => content.split(language === 'Python' ? /\r\n|[\r\n]/u : /\r\n|[\r\n\u2028\u2029]/u),
    [content, language],
  );
  const [pageCursor, setPageCursor] = useState<{ selected: FileSelection; line: number }>();
  const focusLine = pageCursor?.selected === selection ? pageCursor.line : (selection.line ?? 1);
  const page = Math.min(
    Math.floor((focusLine - 1) / linesPerPage),
    Math.ceil(lines.length / linesPerPage) - 1,
  );
  const first = page * linesPerPage;
  const last = Math.min(first + linesPerPage, lines.length);
  const region = useRef<HTMLDivElement>(null);
  const activeRow = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = region.current;
    const row = activeRow.current;
    if (container) {
      container.scrollTop = row
        ? row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2
        : 0;
    }
  }, [focusLine, selection]);

  return (
    <>
      <div className="code-lines" ref={region} role="region" tabIndex={0} aria-label="Source code">
        {lines.slice(first, last).map((line, index) => {
          const number = first + index + 1;
          const active =
            selection.line !== undefined &&
            number >= selection.line &&
            number <= (selection.endLine ?? selection.line);
          return (
            <div
              className={`code-line${active ? ' active' : ''}`}
              key={number}
              data-line={number}
              ref={active && number === focusLine ? activeRow : undefined}
            >
              <button
                type="button"
                aria-label={`Go to line ${number}`}
                tabIndex={-1}
                title={`Line ${number}`}
                onClick={() => onSelect({ path: selection.path, line: number })}
              >
                {number}
              </button>
              <code>{codeTokens(line, language) || ' '}</code>
            </div>
          );
        })}
      </div>
      {lines.length > linesPerPage && (
        <div className="source-pagination">
          <span>
            Lines {first + 1}–{last} of {lines.length.toLocaleString()}
          </span>
          <button
            className="button icon-button"
            type="button"
            aria-label="Previous source page"
            disabled={page === 0}
            onClick={() => setPageCursor({ selected: selection, line: first - linesPerPage + 1 })}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="button icon-button"
            type="button"
            aria-label="Next source page"
            disabled={last === lines.length}
            onClick={() => setPageCursor({ selected: selection, line: last + 1 })}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </>
  );
}

function SourcePane({
  projectId,
  file,
  selection,
  onSelect,
  onExplain,
}: {
  projectId: string;
  file: FileRecord;
  selection: FileSelection;
  onSelect: (selection: FileSelection) => void;
  onExplain: () => void;
}) {
  const [source, setSource] = useState<{ path: string; content: string }>();
  const [failure, setFailure] = useState<string>();
  const [clipboard, setClipboard] = useState<string>();

  useEffect(() => {
    const abort = new AbortController();
    const search = new URLSearchParams({ path: file.path });
    void api<{ path: string; content: string }>(`${projectRoute(projectId)}/source?${search}`, {
      signal: abort.signal,
    }).then(
      (result) => {
        if (!abort.signal.aborted) setSource(result);
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setFailure(errorMessage(error));
      },
    );
    return () => abort.abort();
  }, [file.path, projectId]);

  return (
    <section className="source-pane" aria-labelledby="source-title">
      <header className="source-header">
        <div className="source-heading">
          <FileCode2 size={18} aria-hidden="true" />
          <h2 id="source-title" title={file.path}>
            {file.path}
          </h2>
        </div>
        <div className="source-actions">
          <button
            className="button icon-button"
            type="button"
            aria-label="Copy source"
            title="Copy source"
            disabled={!source}
            onClick={() => {
              if (!source) return;
              if (!navigator.clipboard) {
                setClipboard('Clipboard access is unavailable.');
                return;
              }
              void navigator.clipboard.writeText(source.content).then(
                () => setClipboard('Source copied.'),
                () => setClipboard('Clipboard access failed.'),
              );
            }}
          >
            <Copy size={16} />
          </button>
          <button className="button" type="button" onClick={onExplain}>
            <Sparkles size={15} aria-hidden="true" /> Explain file
          </button>
        </div>
      </header>
      {clipboard && (
        <p role="status" className="status-inline">
          {clipboard}
        </p>
      )}
      {failure ? (
        <ErrorNotice message={failure} />
      ) : source ? (
        <SourceCode
          content={source.content}
          language={file.language}
          selection={selection}
          onSelect={onSelect}
        />
      ) : (
        <Loading>Reading source…</Loading>
      )}
      <footer className="source-footer">
        <span>{file.language}</span>
        <span>{plural(file.lines, 'line')}</span>
        <span>{file.bytes.toLocaleString()} bytes</span>
        {selection.line && (
          <span>
            {selection.endLine && selection.endLine > selection.line
              ? `Lines ${selection.line}–${selection.endLine}`
              : `Line ${selection.line}`}
          </span>
        )}
      </footer>
    </section>
  );
}

function DetailGroup({
  title,
  empty,
  children,
}: {
  title: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="detail-group">
      <h3>{title}</h3>
      {empty ? <p>None found.</p> : children}
    </section>
  );
}

function Diagnostics({
  items,
  onSelect,
  files,
}: {
  items: Diagnostic[];
  onSelect: (selection: FileSelection) => void;
  files: Set<string>;
}) {
  return (
    <DetailGroup title="Analysis diagnostics" empty={!items.length}>
      <ul className="diagnostic-list">
        {items.map((item, index) => (
          <li key={index}>
            <span className={`severity ${item.severity}`}>
              <CircleAlert size={13} /> {item.severity}
            </span>
            <p>{item.message}</p>
            {item.path &&
              (files.has(item.path) ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onSelect({ path: item.path!, line: item.line })}
                >
                  {item.path}
                  {item.line && `:${item.line}`}
                </button>
              ) : (
                <small>
                  {item.path}
                  {item.line && `:${item.line}`}
                </small>
              ))}
          </li>
        ))}
      </ul>
    </DetailGroup>
  );
}

function FileDetails({
  analysis,
  file,
  onSelect,
}: {
  analysis: ProjectAnalysis;
  file: FileRecord | undefined;
  onSelect: (selection: FileSelection) => void;
}) {
  const [tab, setTab] = useState<'Relationships' | 'Symbols' | 'Diagnostics'>(
    file ? 'Relationships' : 'Diagnostics',
  );
  const files = useMemo(() => new Set(analysis.files.map((item) => item.path)), [analysis.files]);
  const incoming = file ? analysis.edges.filter((edge) => edge.target === file.path) : [];
  const entry = analysis.entryPoints.find((entry) => entry.path === file?.path);

  return (
    <aside className="explorer-details" aria-label="File inspection">
      <header className="pane-heading">
        <h2>Inspection</h2>
      </header>
      <div className="detail-tabs" aria-label="Inspection sections">
        {(['Relationships', 'Symbols', 'Diagnostics'] as const).map((item) => (
          <button
            type="button"
            className="detail-tab"
            key={item}
            aria-pressed={tab === item}
            disabled={!file && item !== 'Diagnostics'}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="detail-scroll">
        {tab === 'Diagnostics' && (
          <Diagnostics items={analysis.diagnostics} files={files} onSelect={onSelect} />
        )}
        {tab === 'Relationships' && file && (
          <>
            {entry && (
              <button
                type="button"
                className="entry-tag"
                onClick={() => onSelect({ path: entry.path, line: entry.startLine })}
              >
                <GitBranch size={14} /> Entry point
              </button>
            )}
            <DetailGroup title="Imports" empty={!file.imports.length}>
              <ul className="detail-list">
                {file.imports.map((item, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onSelect({ path: file.path, line: item.startLine })}
                    >
                      {item.specifier}
                      <span>L{item.startLine}</span>
                    </button>
                    {item.resolvedPath && (
                      <button
                        type="button"
                        className="resolved-link"
                        onClick={() => onSelect({ path: item.resolvedPath! })}
                      >
                        <GitBranch size={13} /> {item.resolvedPath}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </DetailGroup>
            <DetailGroup title="Imported by" empty={!incoming.length}>
              <ul className="detail-list">
                {incoming.map((edge) => (
                  <li key={edge.source}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        onSelect({ path: edge.source, line: edge.references[0]?.startLine })
                      }
                    >
                      {edge.source}
                    </button>
                  </li>
                ))}
              </ul>
            </DetailGroup>
            <DetailGroup title="Exports" empty={!file.exports.length}>
              <ul className="detail-list">
                {file.exports.map((item, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onSelect({ path: file.path, line: item.startLine })}
                    >
                      {item.name}
                      <span>L{item.startLine}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </DetailGroup>
          </>
        )}
        {tab === 'Symbols' && file && (
          <DetailGroup title="Declared symbols" empty={!file.symbols.length}>
            <ul className="detail-list">
              {file.symbols.map((item, index) => (
                <li key={index}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onSelect({ path: file.path, line: item.startLine })}
                  >
                    {item.name}
                    <span>L{item.startLine}</span>
                  </button>
                  <small>{item.kind}</small>
                </li>
              ))}
            </ul>
          </DetailGroup>
        )}
      </div>
    </aside>
  );
}

export function Explorer({
  analysis,
  selection,
  onSelect,
  onExplain,
}: {
  analysis: ProjectAnalysis;
  selection: FileSelection | undefined;
  onSelect: (selection: FileSelection) => void;
  onExplain: () => void;
}) {
  const file = analysis.files.find((item) => item.path === selection?.path);

  return (
    <div className="page workbench-page">
      <header className="workbench-header">
        <div>
          <h1>Repository Explorer</h1>
          <p>{analysis.project.name}</p>
        </div>
        <span className="summary-chip">
          <FileCode2 size={15} /> {plural(analysis.files.length, 'file')}
        </span>
      </header>
      <div className="panel explorer-grid">
        <FileTree files={analysis.files} selected={file?.path} onSelect={onSelect} />
        {file && selection ? (
          <SourcePane
            key={file.path}
            projectId={analysis.project.id}
            file={file}
            selection={selection}
            onSelect={onSelect}
            onExplain={onExplain}
          />
        ) : (
          <section className="source-pane blank-source">
            <FileCode2 size={27} aria-hidden="true" />
            <h2>No source file selected</h2>
            <p>Choose a file in the repository tree to inspect it.</p>
          </section>
        )}
        <FileDetails analysis={analysis} file={file} onSelect={onSelect} />
      </div>
    </div>
  );
}
