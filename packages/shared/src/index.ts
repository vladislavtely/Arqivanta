export interface SourceRef {
  path: string;
  startLine: number;
  endLine: number;
}

export interface RepositoryCitation extends SourceRef {
  id: string;
}

export interface RepositoryContextExcerpt extends RepositoryCitation {
  source: string;
}

export interface RepositoryContext {
  snapshotId: string;
  excerpts: RepositoryContextExcerpt[];
  dependencies: { source: string; target: string; evidence: string }[];
  estimatedTokens: number;
}

export type RepositoryStreamEvent =
  | { type: 'context'; context: RepositoryContext }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; citations: RepositoryCitation[] }
  | { type: 'error'; message: string };

export const repositoryAiLimits = {
  minContextWindow: 2_048,
  maxContextWindow: 32_768,
  defaultContextWindow: 8_192,
  maxQuestionLength: 1_500,
  maxPriorQuestions: 3,
} as const;

export type SourceFile = { path: string; source: string; bytes: number };

export function isJavaScriptOrTypeScript(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path);
}

export function isPythonSource(path: string): boolean {
  return /\.pyi?$/.test(path);
}

export function comparePaths(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ImportRecord {
  specifier: string;
  kind: string;
  startLine: number;
  endLine: number;
  resolvedPath?: string;
}

export interface ExportRecord {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export type SymbolRecord = ExportRecord;

export interface FileRecord {
  path: string;
  language: string;
  bytes: number;
  lines: number;
  imports: ImportRecord[];
  exports: ExportRecord[];
  symbols: SymbolRecord[];
}

export interface DependencyEdge {
  source: string;
  target: string;
  references: SourceRef[];
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  line?: number;
}

export interface AnalysisResult {
  files: FileRecord[];
  edges: DependencyEdge[];
  entryPoints: SourceRef[];
  diagnostics: Diagnostic[];
  sources: Record<string, string>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  origin: 'local' | 'github' | 'example';
  createdAt: string;
  fileCount: number;
  edgeCount: number;
  commitSha?: string;
  repositoryUrl?: string;
}

export interface ProjectAnalysis extends Omit<AnalysisResult, 'sources'> {
  project: ProjectSummary;
}
