import type { FolderLink } from '@arqivanta/graph-engine';
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
      fileCount: number;
      internal: number;
      incoming: number;
      outgoing: number;
    }
  | { type: 'folder link'; link: FolderLink }
  | { type: 'file'; file: FileRecord; entryPoint: boolean; incoming: number; outgoing: number }
  | { type: 'file link'; link: DependencyEdge };

function lineLabel(ref: SourceRef) {
  return ref.path + ':' + ref.startLine + (ref.endLine > ref.startLine ? '–' + ref.endLine : '');
}

export function GraphInspector({
  selection,
  folderView,
  onOpenFolder,
  onFocusFile,
  onOpenFile,
}: {
  selection?: GraphSelection;
  folderView: boolean;
  onOpenFolder: (path: string) => void;
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
        <button type="button" className="button" onClick={() => onOpenFolder(selection.path)}>
          Open folder
        </button>
      </>
    );
  } else if (selection?.type === 'folder link') {
    const { link } = selection;
    details = (
      <>
        <h2>
          <GitBranch size={17} aria-hidden="true" /> Folder connection
        </h2>
        <dl className="graph-relation">
          <dt>Source folder</dt>
          <dd>{folderName(link.source)}</dd>
          <dt>Target folder</dt>
          <dd>{folderName(link.target)}</dd>
        </dl>
        <p className="inspector-label">
          {plural(link.count, 'file dependency', 'file dependencies')}
        </p>
        <ul className="graph-references">
          {link.examples.map((example) => {
            const ref = example.references[0];
            return (
              <li key={JSON.stringify([example.source, example.target])}>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => onOpenFile({ path: example.source, line: ref?.startLine })}
                >
                  {fileName(example.source)} imports {fileName(example.target)}
                </button>
              </li>
            );
          })}
        </ul>
        {link.count > link.examples.length && <p>Showing {link.examples.length} examples.</p>}
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
        <ul className="graph-references">
          {link.references.map((ref) => (
            <li key={lineLabel(ref)}>
              <button
                className="text-button"
                type="button"
                onClick={() => onOpenFile({ path: ref.path, line: ref.startLine })}
              >
                {lineLabel(ref)}
              </button>
            </li>
          ))}
        </ul>
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
