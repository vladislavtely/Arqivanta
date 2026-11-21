import { useCallback, useMemo, useState } from 'react';
import type { ProjectAnalysis } from '@arqivanta/shared';
import { buildFolderGraph, buildGraphView, parentFolder } from '@arqivanta/graph-engine';
import type { GraphScope } from '@arqivanta/graph-engine';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
} from '@xyflow/react';
import type {
  Edge,
  EdgeProps,
  Node,
  NodeChange,
  NodePositionChange,
  NodeProps,
  XYPosition,
} from '@xyflow/react';
import {
  ChevronDown,
  FileCode2,
  Folder,
  GitBranch,
  Network,
  RotateCcw,
  Search,
} from 'lucide-react';
import type { FileSelection } from './Explorer';
import { folderName, GraphInspector } from './GraphInspector';
import type { GraphSelection } from './GraphInspector';
import { fileName, plural } from './ui';

type MapScope = GraphScope | 'folders' | 'folder';
type RepositoryNode = Node<
  {
    label: string;
    subtitle: string;
    path: string;
    kind: 'file' | 'folder' | 'entry';
  },
  'repository'
>;

const fileLimit = 350;
const edgeLimit = 1200;
const folderPrefix = 'folder:';
const colors = { outgoing: '#6edce6', incoming: '#ffc47c', neutral: '#817b9c', picked: '#baa8ff' };

function NodeCard({ data, selected }: NodeProps<RepositoryNode>) {
  const Icon = data.kind === 'folder' ? Folder : data.kind === 'entry' ? GitBranch : FileCode2;
  const classes = [
    'graph-node',
    data.kind === 'folder' && 'graph-folder',
    selected && 'graph-node-selected',
  ];
  return (
    <div className={classes.filter(Boolean).join(' ')} title={data.path || data.label}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="graph-node-icon">
        <Icon size={17} aria-hidden="true" />
      </span>
      <span className="graph-node-label">
        <strong>{data.label}</strong>
        <small>{data.subtitle}</small>
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { repository: NodeCard };

type FolderConnectionEdge = Edge<{ labelOffset: number }, 'folderConnection'>;

function FolderConnection({
  data,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  ...props
}: EdgeProps<FolderConnectionEdge>) {
  const labelOffset = data?.labelOffset ?? 0;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    offset: labelOffset > 0 ? 27 : 20,
  });
  return (
    <BaseEdge
      id={props.id}
      path={path}
      labelX={labelX}
      labelY={labelY + labelOffset}
      style={props.style}
      markerEnd={props.markerEnd}
      label={props.label}
      labelStyle={props.labelStyle}
      labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding}
      labelBgBorderRadius={props.labelBgBorderRadius}
    />
  );
}

const edgeTypes = { folderConnection: FolderConnection };

function linkId(link: { source: string; target: string }) {
  return JSON.stringify([link.source, link.target]);
}

function visibleCount(visible: number, total: number, singular: string) {
  return visible === total ? plural(visible, singular) : visible + ' of ' + plural(total, singular);
}

export function Architecture({
  analysis,
  selected,
  onSelect,
  onOpenFile,
}: {
  analysis: ProjectAnalysis;
  selected: string | undefined;
  onSelect: (selection: FileSelection) => void;
  onOpenFile: (selection: FileSelection) => void;
}) {
  const [scope, setScope] = useState<MapScope>(() =>
    analysis.files.length >= 75 || analysis.edges.length >= 160 ? 'folders' : 'all',
  );
  const [query, setQuery] = useState('');
  const [selectedFolder, setSelectedFolder] = useState(() =>
    selected ? parentFolder(selected) : undefined,
  );
  const [folderFilter, setFolderFilter] = useState<string>();
  const [edgeId, setEdgeId] = useState<string>();
  const [layouts, setLayouts] = useState(() => new Map<string, Map<string, XYPosition>>());
  const [revision, setRevision] = useState(0);

  const folderView = scope === 'folders';
  const focus = scope === 'selected' ? selected : undefined;
  const activeFolder = scope === 'folder' ? folderFilter : undefined;
  const layoutKey = JSON.stringify([scope, activeFolder, focus]);
  const positions = layouts.get(layoutKey);
  const folderGraph = useMemo(
    () => (folderView ? buildFolderGraph(analysis.files, analysis.edges, { query }) : undefined),
    [analysis, folderView, query],
  );
  const filesGraph = useMemo(() => {
    if (scope === 'folders') return;
    const files =
      activeFolder === undefined
        ? analysis.files
        : analysis.files.filter((file) => parentFolder(file.path) === activeFolder);
    return buildGraphView(files, analysis.edges, analysis.entryPoints, {
      scope: scope === 'folder' ? 'all' : scope,
      query,
      selected: focus,
      maxFiles: fileLimit,
      maxEdges: edgeLimit,
    });
  }, [analysis, scope, query, focus, activeFolder]);

  const folder = folderGraph?.folders.find((item) => item.path === selectedFolder);
  const file = filesGraph?.files.find((item) => item.file.path === selected);
  const activePath = folder?.path ?? file?.file.path;
  const baseNodes = useMemo((): RepositoryNode[] => {
    if (folderGraph) {
      return folderGraph.folders.map(({ path, fileCount, x, y }) => ({
        id: folderPrefix + path,
        position: { x, y },
        width: 236,
        height: 72,
        type: 'repository',
        ariaLabel: folderName(path),
        data: {
          label: folderName(path),
          subtitle: plural(fileCount, 'file'),
          kind: 'folder',
          path,
        },
        selected: path === selectedFolder,
      }));
    }
    return (filesGraph?.files ?? []).map(({ file, entryPoint, x, y }) => ({
      id: file.path,
      position: { x, y },
      width: 210,
      height: 62,
      type: 'repository',
      ariaLabel: file.path,
      data: {
        label: fileName(file.path),
        subtitle: folderName(parentFolder(file.path)),
        kind: entryPoint ? 'entry' : 'file',
        path: file.path,
      },
      selected: file.path === selected,
    }));
  }, [folderGraph, filesGraph, selectedFolder, selected]);
  const nodes = useMemo(
    () =>
      positions
        ? baseNodes.map((node) => {
            const position = positions.get(node.id);
            return position ? { ...node, position } : node;
          })
        : baseNodes,
    [baseNodes, positions],
  );

  const links = folderGraph?.links ?? filesGraph?.edges;
  const edges = useMemo((): Edge[] => {
    const folderLinks = folderView ? new Set(links?.map(linkId)) : undefined;
    return (links ?? []).map((link) => {
      const id = linkId(link);
      const picked = id === edgeId;
      const outgoing = activePath === link.source;
      const incoming = !outgoing && activePath === link.target;
      const emphasized = picked || outgoing || incoming;
      const color = outgoing
        ? colors.outgoing
        : incoming
          ? colors.incoming
          : picked
            ? colors.picked
            : colors.neutral;
      const muted = activePath !== undefined && !emphasized;
      const count = 'count' in link ? link.count : undefined;
      return {
        id,
        source: folderView ? folderPrefix + link.source : link.source,
        target: folderView ? folderPrefix + link.target : link.target,
        type: folderView ? 'folderConnection' : 'default',
        data: folderLinks?.has(linkId({ source: link.target, target: link.source }))
          ? { labelOffset: link.source < link.target ? -14 : 14 }
          : undefined,
        ariaLabel: folderView
          ? folderName(link.source) +
            ' imports ' +
            folderName(link.target) +
            ', ' +
            plural(count ?? 0, 'file dependency', 'file dependencies')
          : link.source + ' imports ' + link.target,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
        selected: picked,
        zIndex: picked ? 3 : emphasized ? 2 : 0,
        style: {
          stroke: color,
          strokeWidth:
            (emphasized ? 2.3 : 1.4) +
            (count === undefined ? 0 : Math.min(1.7, Math.log2(count) * 0.28)),
          strokeDasharray: incoming ? '6 4' : undefined,
          opacity: muted ? 0.15 : 1,
        },
        label:
          count !== undefined &&
          (emphasized || (activePath === undefined && (links?.length ?? 0) < 18))
            ? String(count)
            : undefined,
        labelStyle: { fill: '#f0e9ff', fontSize: 12, fontWeight: 650 },
        labelBgStyle: { fill: '#211b2c', fillOpacity: 0.95 },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 5,
      };
    });
  }, [activePath, edgeId, folderView, links]);

  const counts = useMemo(() => {
    const related = { incoming: 0, outgoing: 0 };
    if (selected) {
      for (const link of analysis.edges) {
        if (link.source === selected) related.outgoing++;
        if (link.target === selected) related.incoming++;
      }
    }
    return related;
  }, [analysis.edges, selected]);
  const activeLink = useMemo(
    () => (edgeId === undefined ? undefined : links?.find((link) => linkId(link) === edgeId)),
    [edgeId, links],
  );
  let inspector: GraphSelection | undefined;
  if (activeLink) {
    inspector =
      'count' in activeLink
        ? { type: 'folder link', link: activeLink }
        : { type: 'file link', link: activeLink };
  } else if (folder) {
    inspector = { type: 'folder', ...folder };
  } else if (file) {
    inspector = { type: 'file', file: file.file, entryPoint: file.entryPoint, ...counts };
  }

  function changeScope(value: MapScope) {
    setScope(value);
    setEdgeId(undefined);
  }
  function openFolder(path: string) {
    setFolderFilter(path);
    setQuery('');
    changeScope('folder');
  }
  function focusFile() {
    setQuery('');
    changeScope('selected');
  }
  function resetLayout() {
    setLayouts((previous) => {
      const next = new Map(previous);
      next.delete(layoutKey);
      return next;
    });
    setRevision((previous) => previous + 1);
  }
  const selectNode = useCallback(
    (id: string) => {
      setEdgeId(undefined);
      if (folderView) setSelectedFolder(id.slice(folderPrefix.length));
      else onSelect({ path: id });
    },
    [folderView, onSelect],
  );
  const changeNodes = useCallback(
    (changes: NodeChange<RepositoryNode>[]) => {
      const moved = changes.filter(
        (change): change is NodePositionChange =>
          change.type === 'position' && change.position !== undefined,
      );
      if (moved.length) {
        setLayouts((previous) => {
          const next = new Map(previous.get(layoutKey));
          for (const change of moved) if (change.position) next.set(change.id, change.position);
          return new Map(previous).set(layoutKey, next);
        });
      }
      const picked = changes.find((change) => change.type === 'select' && change.selected);
      if (picked?.type === 'select') selectNode(picked.id);
    },
    [layoutKey, selectNode],
  );

  const searchLabel = folderView ? 'Search folders or files' : 'Search graph files';
  const summary = folderGraph
    ? visibleCount(folderGraph.folders.length, folderGraph.matchingFolderCount, 'folder') +
      ' · ' +
      visibleCount(folderGraph.links.length, folderGraph.matchingLinkCount, 'folder connection')
    : visibleCount(filesGraph?.files.length ?? 0, filesGraph?.matchingFileCount ?? 0, 'file') +
      ' · ' +
      visibleCount(filesGraph?.edges.length ?? 0, filesGraph?.matchingEdgeCount ?? 0, 'dependency');

  return (
    <div className="page workbench-page">
      <header className="workbench-header">
        <div>
          <h1>Architecture Map</h1>
          <p>{analysis.project.name}</p>
        </div>
        <span className="summary-chip">
          <Network size={15} aria-hidden="true" /> {plural(analysis.edges.length, 'dependency')}
        </span>
      </header>
      <div
        className={
          activePath === undefined ? 'panel graph-panel' : 'panel graph-panel has-direction-legend'
        }
      >
        <div className="graph-toolbar">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setEdgeId(undefined);
              }}
            />
          </label>
          <label className="select-field">
            <select
              aria-label="Filter architecture map"
              value={scope}
              onChange={(event) => changeScope(event.target.value as MapScope)}
            >
              <option value="folders">Folders</option>
              <option value="all">All files</option>
              <option value="connected">Connected files</option>
              <option value="entry-points">Entry points and neighbors</option>
              <option value="selected" disabled={!selected}>
                Selected file and neighbors
              </option>
              {folderFilter !== undefined && (
                <option value="folder">Files in {folderName(folderFilter)}</option>
              )}
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
          {scope === 'folder' && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setQuery('');
                changeScope('folders');
              }}
            >
              Back to folders
            </button>
          )}
          <button
            type="button"
            className="button"
            disabled={!positions?.size}
            onClick={resetLayout}
          >
            <RotateCcw size={15} aria-hidden="true" /> Reset layout
          </button>
          <span className="graph-count" aria-live="polite">
            {summary}
          </span>
        </div>
        {activePath !== undefined && (
          <div className="graph-legend" aria-label="Dependency direction">
            <span style={{ color: colors.outgoing }}>Imports</span>
            <span className="incoming" style={{ color: colors.incoming }}>
              Imported by
            </span>
          </div>
        )}
        <div className="graph-body">
          <section className="graph-canvas" aria-label="Repository dependency graph">
            {nodes.length ? (
              <ReactFlow
                key={JSON.stringify([layoutKey, query.trim().toLowerCase(), revision])}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                colorMode="dark"
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
                minZoom={0.1}
                nodesDraggable
                nodesConnectable={false}
                selectNodesOnDrag={false}
                deleteKeyCode={null}
                onlyRenderVisibleElements
                onNodeClick={(_, node) => selectNode(node.id)}
                onNodeDoubleClick={(_, node) =>
                  folderView ? openFolder(node.data.path) : onOpenFile({ path: node.data.path })
                }
                onNodesChange={changeNodes}
                onEdgeClick={(_, edge) => setEdgeId(edge.id)}
                onEdgesChange={(changes) => {
                  const picked = changes.find(
                    (change) => change.type === 'select' && change.selected,
                  );
                  if (picked?.type === 'select') setEdgeId(picked.id);
                }}
                onPaneClick={() => setEdgeId(undefined)}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={23} size={1} color="#383845" />
                <Controls showInteractive={false} />
                <MiniMap
                  className="graph-minimap"
                  pannable
                  zoomable
                  nodeColor={(node) => (node.selected ? '#b2a2ff' : '#565075')}
                  ariaLabel="Dependency graph miniature"
                />
              </ReactFlow>
            ) : (
              <div className="blank-source">
                <Network size={28} aria-hidden="true" />
                <h2>{folderView ? 'No matching folders' : 'No matching files'}</h2>
                <p>Change the graph search or filter.</p>
              </div>
            )}
          </section>
          <GraphInspector
            selection={inspector}
            folderView={folderView}
            onOpenFolder={openFolder}
            onFocusFile={scope === 'selected' ? undefined : focusFile}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
    </div>
  );
}
