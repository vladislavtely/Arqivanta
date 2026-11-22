import { createHash } from 'node:crypto';
import { comparePaths, isPythonSource } from '@arqivanta/shared';
import type {
  CodeTrace,
  FlowAnchor,
  FlowCall,
  FlowDefinition,
  ProjectAnalysis,
  SavedTrace,
  SavedTraceReview,
  SourceRef,
  TraceStep,
} from '@arqivanta/shared';

const maxSteps = 80;
const maxDepth = 7;

function digest(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

export function flowReference({ path, startLine, endLine }: SourceRef): SourceRef {
  return { path, startLine, endLine };
}

export function flowKey({ path, key }: FlowAnchor) {
  return JSON.stringify([path, key]);
}

export function flowResolver(analysis: ProjectAnalysis) {
  const definitions = new Map<string, FlowDefinition>();
  const exported = new Map<string, FlowDefinition | null>();
  const imports = new Map<string, Map<string, string | null>>();
  for (const file of analysis.files) {
    for (const definition of file.flow ?? []) {
      definitions.set(flowKey(definition), definition);
      if (definition.exportName === undefined) continue;
      const key = flowKey({ path: file.path, key: definition.exportName });
      exported.set(key, exported.has(key) ? null : definition);
    }
    if (!file.flow?.length) continue;
    const modules = new Map<string, string | null>();
    imports.set(file.path, modules);
    for (const { specifier, resolvedPath } of file.imports) {
      if (!resolvedPath) continue;
      const previous = modules.get(specifier);
      modules.set(
        specifier,
        previous === undefined || previous === resolvedPath ? resolvedPath : null,
      );
    }
  }
  return {
    definitions,
    resolve(path: string, call: FlowCall): FlowDefinition | undefined {
      if (!call.binding) return;
      const { name, module } = call.binding;
      if (module === undefined) return definitions.get(flowKey({ path, key: name }));
      const targetPath = imports.get(path)?.get(module);
      return targetPath
        ? (exported.get(flowKey({ path: targetPath, key: name })) ?? undefined)
        : undefined;
    },
  };
}

export function buildCodeTrace(
  analysis: ProjectAnalysis,
  anchor: FlowAnchor,
): CodeTrace | undefined {
  const flow = flowResolver(analysis);
  const root = flow.definitions.get(flowKey(anchor));
  if (!root) return;
  const entry: TraceStep = {
    id: 'entry',
    depth: 0,
    label: root.label,
    state: 'entry',
    evidence: root.registration ?? flowReference(root),
    definition: flowReference(root),
  };
  const trace: CodeTrace = { anchor, label: root.label, steps: [entry], limited: false };
  const expanded = new Set<string>();

  function visit(definition: FlowDefinition, parent: TraceStep) {
    expanded.add(flowKey(definition));
    const occurrences = new Map<string, number>();
    for (const call of definition.calls) {
      if (trace.steps.length >= maxSteps || parent.depth >= maxDepth) {
        trace.limited = true;
        break;
      }
      const target = flow.resolve(definition.path, call);
      const identity = JSON.stringify([parent.id, call.label]);
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      const step: TraceStep = {
        id: digest(`${identity}:${occurrence}`),
        depth: parent.depth + 1,
        label: target?.label ?? call.label,
        evidence: { path: definition.path, startLine: call.startLine, endLine: call.endLine },
        definition: target && flowReference(target),
        state: target ? (expanded.has(flowKey(target)) ? 'revisited' : 'resolved') : 'unresolved',
      };
      trace.steps.push(step);
      if (target && step.state === 'resolved') visit(target, step);
    }
  }

  visit(root, entry);
  return trace;
}

export function traceFingerprints(trace: CodeTrace, read: (path: string) => string | undefined) {
  const range = sourceRanges(read);
  function fingerprint(reference: SourceRef) {
    const content = range(reference);
    return content === undefined ? undefined : [reference.path, digest(content)];
  }
  return Object.fromEntries(
    trace.steps.map((step) => [
      step.id,
      digest(
        JSON.stringify([
          step.label,
          step.state,
          fingerprint(step.evidence),
          step.definition && fingerprint(step.definition),
        ]),
      ),
    ]),
  );
}

export function sourceRanges(read: (path: string) => string | undefined) {
  const lineCache = new Map<string, string[]>();
  return ({ path, startLine, endLine }: SourceRef) => {
    let lines = lineCache.get(path);
    if (!lines) {
      const content = read(path);
      if (content === undefined) return;
      lines = content.split(isPythonSource(path) ? /\r\n|[\n\r]/gu : /\r\n|[\n\r\u2028\u2029]/gu);
      if (lineCache.size >= 8) lineCache.delete(lineCache.keys().next().value!);
      lineCache.set(path, lines);
    }
    if (startLine < 1 || startLine > endLine || endLine > lines.length) return;
    return lines.slice(startLine - 1, endLine).join('\n');
  };
}

export function reviewSavedTrace(
  saved: SavedTrace,
  current: CodeTrace | undefined,
  read: (path: string) => string | undefined,
  available: (snapshotId: string) => boolean,
): SavedTraceReview {
  const currentFingerprints = current ? traceFingerprints(current, read) : {};
  const changes: SavedTraceReview['changes'] = [];
  for (const { id } of saved.trace.steps) {
    const latest = currentFingerprints[id];
    changes.push({
      id,
      status:
        latest === undefined
          ? 'removed'
          : latest === saved.fingerprints[id]
            ? 'unchanged'
            : 'changed',
    });
  }
  for (const id of Object.keys(currentFingerprints).sort(comparePaths)) {
    if (!Object.hasOwn(saved.fingerprints, id)) changes.push({ id, status: 'added' });
  }
  const availableSnapshots = [
    ...new Set([saved.snapshotId, ...Object.values(saved.stepSnapshots ?? {})]),
  ].filter(available);
  return {
    saved,
    current,
    previousAvailable: availableSnapshots.length > 0,
    availableSnapshots,
    changes,
  };
}
