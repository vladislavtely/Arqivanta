export interface SourceRef {
  path: string;
  startLine: number;
  endLine: number;
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
