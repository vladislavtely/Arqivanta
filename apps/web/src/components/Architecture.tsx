import { useMemo, useState } from 'react';
import type { ProjectAnalysis } from '@arqivanta/shared';
import { buildGraphView } from '@arqivanta/graph-engine';
import type { GraphScope } from '@arqivanta/graph-engine';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
} from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import { ChevronDown, FileCode2, GitBranch, Network, Search } from 'lucide-react';
import type { FileSelection } from './Explorer';
import { fileName, plural } from './ui';

type FileNode = Node<{ path: string; entryPoint: boolean }, 'file'>;

function FileNodeCard({ data, selected }: NodeProps<FileNode>) {
  const directory = data.path.includes('/')
    ? data.path.slice(0, data.path.lastIndexOf('/'))
    : 'Repository root';
  return (
    <div className={`graph-node${selected ? ' graph-node-selected' : ''}`} title={data.path}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="graph-node-icon">
        {data.entryPoint ? <GitBranch size={16} /> : <FileCode2 size={16} />}
      </span>
      <span className="graph-node-label">
        <strong>{fileName(data.path)}</strong>
        <small>{directory}</small>
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { file: FileNodeCard };

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
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<GraphScope>('all');
  const [edgeId, setEdgeId] = useState<string>();
  const graph = useMemo(
    () => buildGraphView(analysis.files, analysis.edges, analysis.entryPoints, { scope, query }),
    [analysis, scope, query],
  );
  const file = graph.files.find((item) => item.file.path === selected);
  const nodes = useMemo(
    (): FileNode[] =>
      graph.files.map(({ file, entryPoint, x, y }) => ({
        id: file.path,
        position: { x, y },
        width: 210,
        height: 62,
        type: 'file',
        ariaLabel: file.path,
        data: { path: file.path, entryPoint },
        selected: selected === file.path,
      })),
    [graph.files, selected],
  );
  const edges = useMemo(
    (): Edge[] =>
      graph.edges.map((edge) => {
        const id = JSON.stringify([edge.source, edge.target]);
        const active = edgeId === id || selected === edge.source || selected === edge.target;
        const color = active ? '#a290ff' : '#62647e';
        return {
          id,
          source: edge.source,
          target: edge.target,
          ariaLabel: `${edge.source} imports ${edge.target}`,
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
          selected: edgeId === id,
          style: { stroke: color, strokeWidth: active ? 2 : 1.4 },
        };
      }),
    [edgeId, graph.edges, selected],
  );
  const edgeIndex = edges.findIndex((edge) => edge.id === edgeId);
  const edge = graph.edges[edgeIndex];

  return (
    <div className="page workbench-page">
      <header className="workbench-header">
        <div>
          <h1>Architecture Map</h1>
          <p>{analysis.project.name}</p>
        </div>
        <span className="summary-chip">
          <Network size={15} /> {plural(graph.edges.length, 'dependency')}
        </span>
      </header>
      <div className="panel graph-panel">
        <div className="graph-toolbar">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search graph files"
              placeholder="Search graph files"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="select-field">
            <select
              aria-label="Filter architecture map"
              value={scope}
              onChange={(event) => setScope(event.target.value as GraphScope)}
            >
              <option value="all">All files</option>
              <option value="connected">Connected files</option>
              <option value="entry-points">Entry points and neighbors</option>
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
          <span className="graph-count" aria-live="polite">
            {plural(graph.files.length, 'file')} · {plural(graph.edges.length, 'dependency')}
          </span>
        </div>
        <div className="graph-body">
          <section className="graph-canvas" aria-label="Repository dependency graph">
            {nodes.length ? (
              <ReactFlow
                key={`${scope}/${query.trim().toLowerCase()}`}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                colorMode="dark"
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
                minZoom={0.1}
                nodesDraggable={false}
                nodesConnectable={false}
                onlyRenderVisibleElements
                elementsSelectable
                onNodeClick={(_, node) => {
                  setEdgeId(undefined);
                  onSelect({ path: node.id });
                }}
                onNodeDoubleClick={(_, node) => onOpenFile({ path: node.id })}
                onNodesChange={(changes) => {
                  for (const change of changes) {
                    if (change.type === 'select' && change.selected) {
                      setEdgeId(undefined);
                      onSelect({ path: change.id });
                    }
                  }
                }}
                onEdgeClick={(_, selectedEdge) => setEdgeId(selectedEdge.id)}
                onEdgesChange={(changes) => {
                  for (const change of changes)
                    if (change.type === 'select' && change.selected) setEdgeId(change.id);
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
                <h2>No matching files</h2>
                <p>Change the graph search or filter.</p>
              </div>
            )}
          </section>
          <aside className="graph-inspector" aria-label="Graph selection">
            {edge ? (
              <>
                <h2>
                  <GitBranch size={17} /> Verified dependency
                </h2>
                <dl className="graph-relation">
                  <dt>Source</dt>
                  <dd>{edge.source}</dd>
                  <dt>Target</dt>
                  <dd>{edge.target}</dd>
                </dl>
                <p className="inspector-label">Source references</p>
                <ul className="graph-references">
                  {edge.references.map((reference, index) => (
                    <li key={index}>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          onOpenFile({ path: reference.path, line: reference.startLine })
                        }
                      >
                        {reference.path}:{reference.startLine}
                        {reference.endLine > reference.startLine && `–${reference.endLine}`}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : file ? (
              <>
                <h2>
                  <FileCode2 size={17} /> {fileName(file.file.path)}
                </h2>
                <p className="inspector-path">{file.file.path}</p>
                {file.entryPoint && (
                  <p className="entry-tag">
                    <GitBranch size={14} /> Entry point
                  </p>
                )}
                <div className="inspector-metrics">
                  <span>{plural(file.file.imports.length, 'import')}</span>
                  <span>{plural(file.file.exports.length, 'export')}</span>
                </div>
                <button
                  type="button"
                  className="button"
                  onClick={() => onOpenFile({ path: file.file.path })}
                >
                  Open in Explorer
                </button>
              </>
            ) : (
              <>
                <h2>
                  <Network size={17} /> Graph selection
                </h2>
                <p>Select a file or dependency to inspect its source references.</p>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
