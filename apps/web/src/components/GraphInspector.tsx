import { useMemo, useState } from 'react';
import type { DependencyEdge, FileRecord, SourceRef } from '@arqivanta/shared';
import { FileCode2, FolderOpen, GitBranch, Network } from 'lucide-react';
import type { FileSelection } from './Explorer';
import { fileName, plural } from './ui';

export function folderName(path: string) {
  return path || 'Repository root';
}

export type GraphSelection =
  | {
      type: 'folder';
      path: string;
      expanded: boolean;
      hiddenChildren: number;
      fileCount: number;
      internal: number;
      incoming: number;
      outgoing: number;
    }
  | { type: 'group link'; source: string; target: string; dependencies: DependencyEdge[] }
  | { type: 'file'; file: FileRecord; entryPoint: boolean; incoming: number; outgoing: number }
  | { type: 'file link'; link: DependencyEdge };

function lineLabel(ref: SourceRef) {
  return ref.path + ':' + ref.startLine + (ref.endLine > ref.startLine ? '–' + ref.endLine : '');
}

const perPage = 20;

function ImportLocations({
  references,
  onOpenFile,
}: {
  references: SourceRef[];
  onOpenFile: (selection: FileSelection) => void;
}) {
  const [page, setPage] = useState(0);
  return (
    <>
      <ul className="graph-references">
        {references.slice(page * perPage, (page + 1) * perPage).map((ref) => (
          <li key={lineLabel(ref)}>
            <button
              className="text-button"
              type="button"
              onClick={() =>
                onOpenFile({ path: ref.path, line: ref.startLine, endLine: ref.endLine })
              }
            >
              {lineLabel(ref)}
            </button>
          </li>
        ))}
      </ul>
      <EvidencePages
        page={page}
        total={references.length}
        onPage={setPage}
        title="import locations"
      />
    </>
  );
}

function EvidencePages({
  page,
  total,
  onPage,
  title,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
  title: string;
}) {
  const pages = Math.ceil(total / perPage);
  if (pages <= 1) return null;
  return (
    <div className="graph-evidence-pages">
      <button
        type="button"
        className="button"
        aria-label={'Previous ' + title + ' page'}
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </button>
      <span aria-live="polite">
        {page + 1} / {pages}
      </span>
      <button
        type="button"
        className="button"
        aria-label={'Next ' + title + ' page'}
        disabled={page + 1 === pages}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </div>
  );
}

function GroupEvidence({
  dependencies,
  onOpenFile,
}: {
  dependencies: DependencyEdge[];
  onOpenFile: (selection: FileSelection) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<DependencyEdge>();
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search
      ? dependencies.filter(
          ({ source, target }) =>
            source.toLowerCase().includes(search) || target.toLowerCase().includes(search),
        )
      : dependencies;
  }, [dependencies, query]);
  return (
    <div className="graph-evidence">
      <label className="search-field">
        <input
          type="search"
          aria-label="Search file pairs"
          placeholder="Search file pairs"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
            setSelected(undefined);
          }}
        />
      </label>
      <p aria-live="polite">{plural(filtered.length, 'file dependency', 'file dependencies')}</p>
      <ul className="graph-references">
        {filtered.slice(page * perPage, (page + 1) * perPage).map((dependency) => (
          <li key={JSON.stringify([dependency.source, dependency.target])}>
            <button
              className="text-button graph-evidence-pair"
              type="button"
              aria-expanded={selected === dependency}
              onClick={() => setSelected(selected === dependency ? undefined : dependency)}
            >
              {dependency.source} imports {dependency.target}
            </button>
            {selected === dependency && (
              <ImportLocations references={dependency.references} onOpenFile={onOpenFile} />
            )}
          </li>
        ))}
      </ul>
      <EvidencePages
        page={page}
        total={filtered.length}
        onPage={(value) => {
          setPage(value);
          setSelected(undefined);
        }}
        title="file pairs"
      />
    </div>
  );
}

export function GraphInspector({
  selection,
  folderView,
  onToggleFolder,
  connectionKey,
  onFocusFile,
  onOpenFile,
}: {
  selection?: GraphSelection;
  folderView: boolean;
  onToggleFolder: (path: string) => void;
  connectionKey?: string;
  onFocusFile?: () => void;
  onOpenFile: (selection: FileSelection) => void;
}) {
  let details;
  if (selection?.type === 'folder') {
    details = (
      <>
        <h2>
          <FolderOpen size={17} aria-hidden="true" /> {folderName(selection.path)}
        </h2>
        <dl className="graph-stats">
          <div>
            <dt>Files</dt>
            <dd>{selection.fileCount}</dd>
          </div>
          <div>
            <dt>Links within folder</dt>
            <dd>{selection.internal}</dd>
          </div>
          <div>
            <dt>Outgoing imports</dt>
            <dd>{selection.outgoing}</dd>
          </div>
          <div>
            <dt>Incoming imports</dt>
            <dd>{selection.incoming}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="button"
          aria-expanded={selection.expanded}
          onClick={() => onToggleFolder(selection.path)}
        >
          {selection.expanded ? 'Collapse folder' : 'Expand folder'}
        </button>
        {selection.hiddenChildren > 0 && <p>Search this folder to bring more items into view.</p>}
      </>
    );
  } else if (selection?.type === 'group link') {
    details = (
      <>
        <h2>
          <GitBranch size={17} aria-hidden="true" /> Group connection
        </h2>
        <dl className="graph-relation">
          <dt>Source</dt>
          <dd>{selection.source}</dd>
          <dt>Target</dt>
          <dd>{selection.target}</dd>
        </dl>
        <GroupEvidence
          key={connectionKey}
          dependencies={selection.dependencies}
          onOpenFile={onOpenFile}
        />
      </>
    );
  } else if (selection?.type === 'file link') {
    const { link } = selection;
    details = (
      <>
        <h2>
          <GitBranch size={17} aria-hidden="true" /> Verified dependency
        </h2>
        <dl className="graph-relation">
          <dt>Source</dt>
          <dd>{link.source}</dd>
          <dt>Target</dt>
          <dd>{link.target}</dd>
        </dl>
        <p className="inspector-label">Source references</p>
        <ImportLocations key={connectionKey} references={link.references} onOpenFile={onOpenFile} />
      </>
    );
  } else if (selection?.type === 'file') {
    const { file } = selection;
    details = (
      <>
        <h2>
          <FileCode2 size={17} aria-hidden="true" /> {fileName(file.path)}
        </h2>
        <p className="inspector-path">{file.path}</p>
        {selection.entryPoint && (
          <p className="entry-tag">
            <GitBranch size={14} aria-hidden="true" /> Entry point
          </p>
        )}
        <dl className="graph-stats">
          <div>
            <dt>Imports</dt>
            <dd>{selection.outgoing}</dd>
          </div>
          <div>
            <dt>Imported by</dt>
            <dd>{selection.incoming}</dd>
          </div>
        </dl>
        <div className="graph-inspector-actions">
          {onFocusFile && (
            <button type="button" className="button" onClick={onFocusFile}>
              Focus on file
            </button>
          )}
          <button type="button" className="button" onClick={() => onOpenFile({ path: file.path })}>
            Open in Explorer
          </button>
        </div>
      </>
    );
  } else {
    details = (
      <>
        <h2>
          <Network size={17} aria-hidden="true" /> Graph selection
        </h2>
        <p>
          {folderView
            ? 'Select a folder or a connection to see its details.'
            : 'Select a file or dependency to inspect its source references.'}
        </p>
      </>
    );
  }

  return (
    <aside className="graph-inspector" aria-label="Graph selection">
      {details}
    </aside>
  );
}
