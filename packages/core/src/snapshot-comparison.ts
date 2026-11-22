import { comparePaths } from '@arqivanta/shared';
import type {
  DependencyEdge,
  ImpactItem,
  ProjectAnalysis,
  SnapshotComparison,
  SourceRef,
} from '@arqivanta/shared';
import { flowKey, flowReference, flowResolver, sourceRanges } from './code-trace.ts';

const displayLimit = 150;
const impactDepth = 8;
const testPath =
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)test_[^/]+\.pyi?$|(?:_test\.pyi?$|\.(?:test|spec)\.[^/]+$)/iu;
type ReverseEdge = { target: string; caller: string; evidence: SourceRef };

function findImpact(
  seeds: readonly string[],
  graphs: {
    snapshotId: string;
    edges: Iterable<ReverseEdge>;
    label?: (key: string) => string | undefined;
  }[],
) {
  const origin = [...new Set(seeds)].sort(comparePaths);
  if (!origin.length) return { items: [], limited: false };
  const found = new Map<string, ImpactItem>();
  let limited = false;
  for (const { snapshotId, edges, label } of graphs) {
    const incoming = new Map<string, ReverseEdge[]>();
    for (const edge of edges) {
      const list = incoming.get(edge.target) ?? [];
      if (!incoming.has(edge.target)) incoming.set(edge.target, list);
      list.push(edge);
    }
    const queue = [...origin];
    const visited = new Map<string, { parent?: string; reference?: SourceRef; distance: number }>(
      origin.map((key) => [key, { distance: 0 }]),
    );
    for (const key of queue) {
      const { distance } = visited.get(key)!;
      for (const { caller, evidence } of incoming.get(key) ?? []) {
        if (visited.has(caller)) continue;
        if (distance === impactDepth) {
          limited = true;
          continue;
        }
        visited.set(caller, { parent: key, reference: evidence, distance: distance + 1 });
        queue.push(caller);
        if ((found.get(caller)?.distance ?? Infinity) <= distance + 1) continue;
        const chain: SourceRef[] = [];
        let step = visited.get(caller);
        while (step?.reference && step.parent) {
          chain.push(step.reference);
          step = visited.get(step.parent);
        }
        found.set(caller, {
          path: evidence.path,
          label: label?.(caller),
          distance: distance + 1,
          chain,
          test: testPath.test(evidence.path),
          snapshotId,
        });
      }
    }
  }
  const items = [...found.values()].sort(
    (a, b) =>
      a.distance - b.distance ||
      comparePaths(a.path, b.path) ||
      comparePaths(a.label ?? '', b.label ?? ''),
  );
  return { items: items.slice(0, displayLimit), limited: limited || items.length > displayLimit };
}

function* importLinks(edges: DependencyEdge[]) {
  for (const edge of edges) {
    const evidence = edge.references[0];
    if (evidence) yield { target: edge.target, caller: edge.source, evidence };
  }
}

function* callLinks(flow: ReturnType<typeof flowResolver>) {
  for (const [caller, definition] of flow.definitions) {
    for (const call of definition.calls) {
      const target = flow.resolve(definition.path, call);
      if (target) {
        yield {
          target: flowKey(target),
          caller,
          evidence: { path: definition.path, startLine: call.startLine, endLine: call.endLine },
        };
      }
    }
  }
}

export function compareSnapshots(
  baseline: ProjectAnalysis,
  current: ProjectAnalysis,
  readBefore: (path: string) => string | undefined,
  readAfter: (path: string) => string | undefined,
): SnapshotComparison {
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  const changedFiles: SnapshotComparison['files'] = [];
  const fileCounts = { added: 0, changed: 0, removed: 0 };
  const deps: SnapshotComparison['dependencies'] = [];
  const dependencyCounts = { added: 0, removed: 0 };
  const definitionCounts = { added: 0, changed: 0, removed: 0 };
  const definitions: SnapshotComparison['definitions'] = [];
  const definitionSeeds: string[] = [];
  const seeds: string[] = [];
  const sourceBefore = sourceRanges(readBefore);
  const sourceAfter = sourceRanges(readAfter);
  const normalize = (source: string | undefined) => source?.replace(/\r\n/gu, '\n');
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort(comparePaths)) {
    const old = before.get(path);
    const next = after.get(path);
    let status: (typeof changedFiles)[number]['status'];
    if (!old) status = 'added';
    else if (!next) status = 'removed';
    else if (
      old.normalizedFingerprint && next.normalizedFingerprint
        ? old.normalizedFingerprint !== next.normalizedFingerprint
        : normalize(readBefore(path)) !== normalize(readAfter(path))
    )
      status = 'changed';
    else continue;
    seeds.push(path);
    fileCounts[status]++;
    if (changedFiles.length < displayLimit) changedFiles.push({ path, status });

    if (!baseline.parseVersion || !current.parseVersion) continue;
    const previous = new Map(old?.flow?.map((definition) => [definition.key, definition]));
    const latest = new Map(next?.flow?.map((definition) => [definition.key, definition]));
    for (const key of new Set([...previous.keys(), ...latest.keys()])) {
      const oldDefinition = previous.get(key);
      const newDefinition = latest.get(key);
      const definition = newDefinition ?? oldDefinition!;
      if (
        oldDefinition &&
        newDefinition &&
        sourceBefore(oldDefinition) === sourceAfter(newDefinition) &&
        (oldDefinition.registration && sourceBefore(oldDefinition.registration)) ===
          (newDefinition.registration && sourceAfter(newDefinition.registration))
      )
        continue;
      const change = oldDefinition ? (newDefinition ? 'changed' : 'removed') : 'added';
      definitionCounts[change]++;
      definitionSeeds.push(flowKey(definition));
      if (definitions.length < displayLimit)
        definitions.push({
          label: definition.label,
          reference: definition.registration ?? flowReference(definition),
          status: change,
        });
    }
  }

  const key = ({ source, target }: DependencyEdge) => JSON.stringify([source, target]);
  for (const [old, next, status] of [
    [baseline.edges, current.edges, 'added'],
    [current.edges, baseline.edges, 'removed'],
  ] as const) {
    const keys = new Set(old.map(key));
    for (const edge of next) {
      if (keys.has(key(edge))) continue;
      dependencyCounts[status]++;
      if (deps.length < displayLimit) deps.push({ edge, status });
      seeds.push(edge.source);
    }
  }

  const imports = findImpact(seeds, [
    { snapshotId: current.project.id, edges: importLinks(current.edges) },
    { snapshotId: baseline.project.id, edges: importLinks(baseline.edges) },
  ]);
  let calls: ReturnType<typeof findImpact> = { items: [], limited: false };
  if (definitionSeeds.length) {
    calls = findImpact(
      definitionSeeds,
      [current, baseline].map((snapshot) => {
        const flow = flowResolver(snapshot);
        return {
          snapshotId: snapshot.project.id,
          edges: callLinks(flow),
          label: (id: string) => flow.definitions.get(id)?.label,
        };
      }),
    );
  }
  return {
    baseline: baseline.project,
    current: current.project,
    fileCounts,
    files: changedFiles,
    dependencyCounts,
    dependencies: deps,
    definitionCounts,
    definitions,
    callImpact: calls.items,
    impact: imports.items,
    limited:
      imports.limited ||
      calls.limited ||
      Object.values(definitionCounts).reduce((total, count) => total + count, 0) > displayLimit ||
      Object.values(fileCounts).reduce((total, count) => total + count, 0) > displayLimit ||
      dependencyCounts.added + dependencyCounts.removed > displayLimit,
  };
}
