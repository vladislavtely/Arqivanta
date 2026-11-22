import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AnalysisResult, ProjectAnalysis, ProjectSummary, SourceRef } from '@arqivanta/shared';

export {
  estimateRepositoryTokens,
  hasSensitiveAiSource,
  isSensitiveAiPath,
  retrieveRepositoryContext,
  verifyRepositoryCitations,
} from './repository-context.ts';

type ProjectOrigin = Pick<ProjectSummary, 'name' | 'origin' | 'commitSha' | 'repositoryUrl'>;

export function openProjectStore(filename: string) {
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA busy_timeout = 2500;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      cache_key TEXT UNIQUE,
      summary TEXT NOT NULL,
      analysis TEXT NOT NULL,
      sources TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_sources (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (project_id, path)
    ) WITHOUT ROWID;
  `);

  const recent = database.prepare(
    'SELECT summary FROM projects ORDER BY created_at DESC, rowid DESC',
  );
  const byId = database.prepare('SELECT analysis FROM projects WHERE id = ?');
  const byCacheKey = database.prepare('SELECT analysis FROM projects WHERE cache_key = ?');
  const sourceByPath = database.prepare(
    'SELECT content FROM project_sources WHERE project_id = ? AND path = ?',
  );
  const sourceRows = database.prepare(
    'SELECT path, content FROM project_sources WHERE project_id = ? ORDER BY path',
  );
  const legacySources = database.prepare(
    "SELECT sources FROM projects WHERE id = ? AND sources <> '{}'",
  );
  const legacySourceByPath = database.prepare(`
    SELECT source.value AS content FROM projects, json_each(projects.sources) AS source
    WHERE projects.id = ? AND projects.sources <> '{}' AND source.key = ? AND source.type = 'text'
  `);
  const insert = database.prepare(`
    INSERT INTO projects VALUES (?, ?, ?, ?, ?, '{}') ON CONFLICT(cache_key) DO NOTHING
  `);
  const insertSource = database.prepare('INSERT INTO project_sources VALUES (?, ?, ?)');
  const trim = database.prepare(`
    DELETE FROM projects WHERE id IN (
      SELECT id FROM projects ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 16
    )
  `);

  function readLegacySources(id: string) {
    const row = legacySources.get(id);
    return row ? (JSON.parse(row.sources as string) as Record<string, unknown>) : {};
  }

  return {
    list(): ProjectSummary[] {
      return recent.all().map((row) => JSON.parse(row.summary as string) as ProjectSummary);
    },
    get(id: string): ProjectAnalysis | undefined {
      const row = byId.get(id);
      return row ? (JSON.parse(row.analysis as string) as ProjectAnalysis) : undefined;
    },
    cached(key: string): ProjectAnalysis | undefined {
      const row = byCacheKey.get(key);
      return row ? (JSON.parse(row.analysis as string) as ProjectAnalysis) : undefined;
    },
    source(id: string, path: string): string | undefined {
      const row = sourceByPath.get(id, path) ?? legacySourceByPath.get(id, path);
      return row?.content as string | undefined;
    },
    *sourceEntries(id: string): IterableIterator<[path: string, content: string]> {
      let indexed = false;
      for (const row of sourceRows.iterate(id)) {
        indexed = true;
        yield [row.path as string, row.content as string];
      }
      if (indexed) return;
      const entries = readLegacySources(id);
      for (const path of Object.keys(entries).sort()) {
        const content = entries[path];
        if (typeof content === 'string') yield [path, content];
      }
    },
    sourceReader(id: string) {
      let legacy: Record<string, unknown> | undefined;
      return (path: string): string | undefined => {
        const indexed = sourceByPath.get(id, path);
        if (indexed) return indexed.content as string;
        legacy ??= readLegacySources(id);
        const content = Object.hasOwn(legacy, path) ? legacy[path] : undefined;
        return typeof content === 'string' ? content : undefined;
      };
    },
    save(origin: ProjectOrigin, result: AnalysisResult, cacheKey?: string): ProjectAnalysis {
      const { sources, ...analysis } = result;
      const project: ProjectSummary = {
        ...origin,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        fileCount: result.files.length,
        edgeCount: result.edges.length,
      };
      const document = { ...analysis, project };
      database.exec('BEGIN IMMEDIATE');
      try {
        const write = insert.run(
          project.id,
          project.createdAt,
          cacheKey ?? null,
          JSON.stringify(project),
          JSON.stringify(document),
        );
        if (write.changes === 0 && cacheKey) {
          const existing = byCacheKey.get(cacheKey);
          if (!existing) throw new Error('The cached snapshot could not be read.');
          const cached = JSON.parse(existing.analysis as string) as ProjectAnalysis;
          database.exec('COMMIT');
          return cached;
        }
        for (const [path, content] of Object.entries(sources)) {
          insertSource.run(project.id, path, content);
        }
        trim.run();
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return document;
    },
    close() {
      database.close();
    },
  };
}

function contextDocument(analysis: ProjectAnalysis) {
  const directories = new Set<string>();
  for (const file of analysis.files) {
    for (
      let slash = file.path.indexOf('/');
      slash >= 0;
      slash = file.path.indexOf('/', slash + 1)
    ) {
      directories.add(file.path.slice(0, slash));
    }
  }
  const incoming = new Map<string, number>();
  for (const edge of analysis.edges)
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  const mostReferenced = [...incoming]
    .sort(
      ([left, leftCount], [right, rightCount]) => rightCount - leftCount || (left < right ? -1 : 1),
    )
    .slice(0, 5)
    .map(([path, dependents]) => ({ path, dependents }));

  return {
    schemaVersion: 1,
    project: {
      name: analysis.project.name,
      origin: analysis.project.origin,
      commitSha: analysis.project.commitSha,
      repositoryUrl: analysis.project.repositoryUrl,
      fileCount: analysis.files.length,
      edgeCount: analysis.edges.length,
    },
    directories: [...directories].sort(),
    files: analysis.files.map(({ path, language, lines }) => ({ path, language, lines })),
    entryPoints: analysis.entryPoints,
    dependencies: analysis.edges,
    notes: {
      mostReferenced,
      diagnosticCount: analysis.diagnostics.length,
      scope: 'Statically resolved links between files in this snapshot.',
    },
  };
}

function code(value: string) {
  const printable = value.replace(/[\r\n\t]/g, ' ');
  const runs = printable.match(/`+/g) ?? [];
  const delimiter = '`'.repeat(1 + Math.max(0, ...runs.map((run) => run.length)));
  return `${delimiter} ${printable} ${delimiter}`;
}

function reference(ref: SourceRef) {
  return code(
    `${ref.path}:${ref.startLine}${ref.endLine === ref.startLine ? '' : `–${ref.endLine}`}`,
  );
}

export function exportContext(analysis: ProjectAnalysis, format: 'markdown' | 'json'): string {
  const document = contextDocument(analysis);
  if (format === 'json') return `${JSON.stringify(document, null, 2)}\n`;

  const { project, directories, files, entryPoints, dependencies, notes } = document;
  const overview = [
    `Project ${code(project.name)}`,
    `Origin ${project.origin}`,
    `${files.length} files and ${dependencies.length} resolved dependencies`,
  ];
  if (project.repositoryUrl && project.commitSha) {
    overview.push(`Repository ${code(project.repositoryUrl)} at ${code(project.commitSha)}`);
  }

  return [
    '# Repository context',
    '',
    ...overview.map((line) => `- ${line}`),
    '',
    '## Directory structure',
    '',
    ...(directories.length
      ? directories.map((directory) => `- ${code(`${directory}/`)}`)
      : ['Files are located at the project root.']),
    '',
    '## Files',
    '',
    ...files.map((file) => `- ${code(file.path)} · ${file.language} · ${file.lines} lines`),
    '',
    '## Entry points',
    '',
    ...(entryPoints.length
      ? entryPoints.map((entry) => `- ${reference(entry)}`)
      : ['No entry points were identified.']),
    '',
    '## Verified dependencies',
    '',
    ...(dependencies.length
      ? dependencies.map(
          (edge) =>
            `- ${code(edge.source)} → ${code(edge.target)} (${edge.references.map(reference).join(', ')})`,
        )
      : ['No local dependencies were resolved.']),
    '',
    '## Architecture notes',
    '',
    '- Dependencies are statically resolved within the analyzed snapshot.',
    `- Analysis reported ${notes.diagnosticCount} diagnostics.`,
    ...notes.mostReferenced.map(
      ({ path, dependents }) =>
        `- ${code(path)} has ${dependents} local ${dependents === 1 ? 'dependent' : 'dependents'}.`,
    ),
    '',
  ].join('\n');
}
