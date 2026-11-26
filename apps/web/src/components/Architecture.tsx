import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import type { ProjectAnalysis } from '@arqivanta/shared';
import {
  buildGraphView,
  folderDependencyCounts,
  groupDependencyGraph,
  indexFolderGraph,
  parentFolder,
} from '@arqivanta/graph-engine';
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
  Viewport,
  XYPosition,
} from '@xyflow/react';
import {
  ArrowLeft,
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

type MapScope = GraphScope | 'folders';
type MapView = {
  scope: MapScope;
  expanded: ReadonlySet<string>;
  priorityPath?: string;
  query: string;
  nodeId?: string;
  focusPath?: string;
  edgeId?: string;
  positions: ReadonlyMap<string, XYPosition>;
  initialViewport?: Viewport;
};
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
const fitViewOptions = { padding: 0.2, maxZoom: 1.1 };
const colors = { outgoing: '#6edce6', incoming: '#ffc47c', neutral: '#817b9c', picked: '#baa8ff' };

const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<RepositoryNode>) {
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
});

const nodeTypes = { repository: NodeCard };

type FolderConnectionEdge = Edge<{ labelOffset: number }, 'folderConnection'>;

const FolderConnection = memo(function FolderConnection({
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
});

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
  const folderIndex = useMemo(
    () => indexFolderGraph(analysis.files, analysis.edges),
    [analysis.files, analysis.edges],
  );
  const [view, setView] = useState<MapView>(() => ({
    scope: analysis.files.length >= 75 || analysis.edges.length >= 160 ? 'folders' : 'all',
    expanded: folderIndex.initialExpansion,
    query: '',
    positions: new Map(),
  }));
  const [history, setHistory] = useState<MapView[]>([]);
  const [revision, setRevision] = useState(0);
  const viewport = useRef<Viewport>(undefined);
  const { scope, expanded, priorityPath, query, edgeId, positions, initialViewport } = view;
  const graphQuery = useDeferredValue(query.trim().toLowerCase());

  const folderView = scope === 'folders';
  const focus = scope === 'selected' ? (view.focusPath ?? selected) : undefined;
  const folderGraph = useMemo(
    () =>
      folderView
        ? groupDependencyGraph(folderIndex, { expanded, priorityPath, query: graphQuery })
        : undefined,
    [folderIndex, folderView, expanded, priorityPath, graphQuery],
  );
  const filesGraph = useMemo(() => {
    if (scope === 'folders') return;
    return buildGraphView(analysis.files, analysis.edges, analysis.entryPoints, {
      scope,
      query: graphQuery,
      selected: focus,
      maxFiles: fileLimit,
      maxEdges: edgeLimit,
    });
  }, [analysis, scope, graphQuery, focus]);

  const selectedId = view.nodeId ?? (folderView ? undefined : (focus ?? selected));
  const groupedNode = folderGraph?.nodes.find((item) => item.id === selectedId);
  const flatNode = filesGraph?.files.find((item) => item.file.path === selectedId);
  const folder = groupedNode?.kind === 'folder' ? groupedNode : undefined;
  const file = groupedNode?.kind === 'file' ? groupedNode.file : flatNode?.file;
  const activeId = groupedNode?.id ?? flatNode?.file.path;
  const entryPaths = useMemo(
    () => new Set(analysis.entryPoints.map((entry) => entry.path)),
    [analysis.entryPoints],
  );
  const baseNodes = useMemo((): RepositoryNode[] => {
    if (folderGraph) {
      return folderGraph.nodes.map((node) => {
        const { id, path, x, y } = node;
        return {
          id,
          position: { x, y },
          width: 236,
          height: 72,
          type: 'repository',
          ariaLabel: node.kind === 'folder' ? folderName(path) : path,
          data: {
            label: node.kind === 'folder' ? folderName(path) : fileName(path),
            subtitle:
              node.kind === 'folder'
                ? node.expanded
                  ? node.hiddenChildren
                    ? plural(node.hiddenChildren, 'hidden item')
                    : 'Expanded'
                  : plural(node.fileCount, 'file')
                : folderName(parentFolder(path)),
            kind: node.kind === 'folder' ? 'folder' : entryPaths.has(path) ? 'entry' : 'file',
            path,
          },
        };
      });
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
    }));
  }, [folderGraph, filesGraph, entryPaths]);
  const nodes = useMemo(
    () =>
      baseNodes.map((node) => {
        const position = positions.get(node.id);
        return position || node.id === activeId
          ? { ...node, position: position ?? node.position, selected: node.id === activeId }
          : node;
      }),
    [baseNodes, positions, activeId],
  );

  const links = folderGraph?.links ?? filesGraph?.edges;
  const nodesById = useMemo(() => new Map(baseNodes.map((node) => [node.id, node])), [baseNodes]);
  const edges = useMemo((): Edge[] => {
    const folderLinks = folderView ? new Set(links?.map(linkId)) : undefined;
    return (links ?? []).map((link) => {
      const id = linkId(link);
      const picked = id === edgeId;
      const outgoing = activeId === link.source;
      const incoming = !outgoing && activeId === link.target;
      const emphasized = picked || outgoing || incoming;
      const color = outgoing
        ? colors.outgoing
        : incoming
          ? colors.incoming
          : picked
            ? colors.picked
            : colors.neutral;
      const muted = activeId !== undefined && !emphasized;
      const source = nodesById.get(link.source)?.ariaLabel ?? link.source;
      const target = nodesById.get(link.target)?.ariaLabel ?? link.target;
      const grouped =
        nodesById.get(link.source)?.data.kind === 'folder' ||
        nodesById.get(link.target)?.data.kind === 'folder';
      const count = 'count' in link && grouped ? link.count : undefined;
      return {
        id,
        source: link.source,
        target: link.target,
        type: grouped ? 'folderConnection' : 'default',
        data: folderLinks?.has(linkId({ source: link.target, target: link.source }))
          ? { labelOffset: link.source < link.target ? -14 : 14 }
          : undefined,
        ariaLabel:
          source +
          ' imports ' +
          target +
          (count === undefined ? '' : ', ' + plural(count, 'file dependency', 'file dependencies')),
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
          (emphasized || (activeId === undefined && (links?.length ?? 0) < 18))
            ? String(count)
            : undefined,
        labelStyle: { fill: '#f0e9ff', fontSize: 12, fontWeight: 650 },
        labelBgStyle: { fill: '#211b2c', fillOpacity: 0.95 },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 5,
      };
    });
  }, [activeId, edgeId, folderView, links, nodesById]);

  const counts = useMemo(() => {
    const related = { incoming: 0, outgoing: 0 };
    if (file) {
      for (const link of analysis.edges) {
        if (link.source === file.path) related.outgoing++;
        if (link.target === file.path) related.incoming++;
      }
    }
    return related;
  }, [analysis.edges, file]);
  const folderPath = folder?.path;
  const folderCounts = useMemo(
    () =>
      folderPath === undefined ? undefined : folderDependencyCounts(folderIndex.edges, folderPath),
    [folderIndex, folderPath],
  );
  const activeLink = useMemo(
    () => (edgeId === undefined ? undefined : links?.find((link) => linkId(link) === edgeId)),
    [edgeId, links],
  );
  let inspector: GraphSelection | undefined;
  if (activeLink) {
    if ('dependencies' in activeLink) {
      const source = nodesById.get(activeLink.source);
      const target = nodesById.get(activeLink.target);
      inspector =
        source?.data.kind === 'folder' || target?.data.kind === 'folder'
          ? {
              type: 'group link',
              source: source?.ariaLabel ?? activeLink.source,
              target: target?.ariaLabel ?? activeLink.target,
              dependencies: activeLink.dependencies,
            }
          : { type: 'file link', link: activeLink.dependencies[0] };
    } else {
      inspector = { type: 'file link', link: activeLink };
    }
  } else if (folder && folderCounts) {
    inspector = { type: 'folder', ...folder, ...folderCounts };
  } else if (file) {
    inspector = { type: 'file', file, entryPoint: entryPaths.has(file.path), ...counts };
  }

  function navigate(next: MapView) {
    const previous = {
      ...view,
      nodeId: selectedId,
      focusPath: focus,
      initialViewport: viewport.current,
    };
    setHistory((steps) => [...steps.slice(-23), previous]);
    setView(next);
    viewport.current = next.initialViewport;
    setRevision((value) => value + 1);
  }
  function goBack() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setView(previous);
    viewport.current = previous.initialViewport;
    setRevision((value) => value + 1);
  }
  function changeScope(value: MapScope) {
    if (value === scope) return;
    const focusPath = value === 'selected' ? (file?.path ?? selected) : undefined;
    navigate({
      scope: value,
      expanded,
      priorityPath,
      query,
      nodeId: focusPath,
      focusPath,
      positions: new Map(),
    });
  }
  function toggleFolder(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    navigate({
      ...view,
      expanded: next,
      priorityPath: next.has(path) ? path : undefined,
      edgeId: undefined,
      initialViewport: undefined,
    });
  }
  function focusFile() {
    if (!file) return;
    navigate({
      scope: 'selected',
      query: '',
      expanded,
      priorityPath,
      nodeId: file.path,
      focusPath: file.path,
      positions: new Map(),
    });
  }
  function resetLayout() {
    setView((previous) => ({ ...previous, positions: new Map(), initialViewport: undefined }));
    viewport.current = undefined;
    setRevision((previous) => previous + 1);
  }
  const selectEdge = useCallback((id?: string) => {
    setView((previous) => (previous.edgeId === id ? previous : { ...previous, edgeId: id }));
  }, []);
  const rememberViewport = useCallback((_: unknown, value: Viewport) => {
    viewport.current = value;
  }, []);
  const selectNode = useCallback(
    (id: string) => {
      const node = nodesById.get(id);
      if (!node) return;
      setView((previous) =>
        previous.nodeId === id && !previous.edgeId
          ? previous
          : { ...previous, nodeId: id, edgeId: undefined },
      );
      if (node.data.kind !== 'folder') onSelect({ path: node.data.path });
    },
    [nodesById, onSelect],
  );
  const changeNodes = useCallback(
    (changes: NodeChange<RepositoryNode>[]) => {
      const moved = changes.filter(
        (change): change is NodePositionChange =>
          change.type === 'position' && change.position !== undefined,
      );
      if (moved.length) {
        setView((previous) => {
          const next = new Map(previous.positions);
          for (const change of moved) {
            if (!change.position) continue;
            next.delete(change.id);
            next.set(change.id, change.position);
          }
          while (next.size > fileLimit) {
            const oldest = next.keys().next().value;
            if (oldest === undefined) break;
            next.delete(oldest);
          }
          return { ...previous, positions: next };
        });
      }
      const picked = changes.find((change) => change.type === 'select' && change.selected);
      if (picked?.type === 'select') selectNode(picked.id);
    },
    [selectNode],
  );

  const searchLabel = folderView ? 'Search folders or files' : 'Search graph files';
  const summary = folderGraph
    ? visibleCount(
        folderGraph.nodes.length,
        folderGraph.nodes.length + folderGraph.omittedNodes,
        'item',
      ) +
      ' · ' +
      visibleCount(
        folderGraph.links.length,
        folderGraph.links.length + folderGraph.omittedLinks,
        'connection',
      )
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
          activeId === undefined ? 'panel graph-panel' : 'panel graph-panel has-direction-legend'
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
                const value = event.target.value;
                setView((previous) => ({
                  ...previous,
                  query: value,
                  edgeId: undefined,
                  initialViewport: undefined,
                }));
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
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
          <button type="button" className="button" disabled={!history.length} onClick={goBack}>
            <ArrowLeft size={15} aria-hidden="true" /> Back
          </button>
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
        {activeId !== undefined && (
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
                key={JSON.stringify([graphQuery, revision])}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                colorMode="dark"
                fitView={!initialViewport}
                fitViewOptions={fitViewOptions}
                defaultViewport={initialViewport}
                onMove={rememberViewport}
                minZoom={0.1}
                nodesDraggable
                nodesConnectable={false}
                selectNodesOnDrag={false}
                deleteKeyCode={null}
                onlyRenderVisibleElements
                onNodeClick={(_, node) => selectNode(node.id)}
                onNodeDoubleClick={(_, node) =>
                  node.data.kind === 'folder'
                    ? toggleFolder(node.data.path)
                    : onOpenFile({ path: node.data.path })
                }
                onNodesChange={changeNodes}
                onEdgeClick={(_, edge) => selectEdge(edge.id)}
                onEdgesChange={(changes) => {
                  const picked = changes.find(
                    (change) => change.type === 'select' && change.selected,
                  );
                  if (picked?.type === 'select') selectEdge(picked.id);
                }}
                onPaneClick={() => selectEdge()}
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
                <h2>{folderView ? 'No matching groups' : 'No matching files'}</h2>
                <p>Change the graph search or filter.</p>
              </div>
            )}
          </section>
          <GraphInspector
            selection={inspector}
            folderView={folderView}
            onToggleFolder={toggleFolder}
            onFocusFile={focus === file?.path ? undefined : focusFile}
            connectionKey={activeLink ? linkId(activeLink) : undefined}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
    </div>
  );
}
