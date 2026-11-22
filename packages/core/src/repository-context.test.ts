import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AnalysisResult, FileRecord, ProjectAnalysis } from '@arqivanta/shared';
import { describe, expect, it } from 'vitest';
import {
  estimateRepositoryTokens,
  hasSensitiveAiSource,
  isSensitiveAiPath,
  openProjectStore,
  retrieveRepositoryContext,
  verifyRepositoryCitations,
} from './index.ts';

function file(path: string, source: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    path,
    language: 'TypeScript',
    bytes: Buffer.byteLength(source, 'utf8'),
    lines: source.split(/\r\n|[\r\n\u2028\u2029]/u).length,
    imports: [],
    exports: [],
    symbols: [],
    ...overrides,
  };
}

function fixture(): AnalysisResult {
  const entry =
    "import { publish } from './publisher.js';\r\n\r\nexport function createReport(items: string[]) {\r\n  return publish(items);\r\n}\r\n";
  const publisher = [
    'export function publish(items: string[]) {',
    '  return items.filter(Boolean).join(", ");',
    '}',
  ].join('\n');
  const unrelated = 'const orchard = "pears";';
  const db = 'const unsupported = true;';
  const unsafe = 'const password = "fake-pw-content";';
  return {
    files: [
      file('src/start.ts', entry, {
        symbols: [{ name: 'createReport', kind: 'function', startLine: 3, endLine: 5 }],
      }),
      file('src/publisher.ts', publisher),
      file('src/orchard.ts', unrelated),
      file('config/dbCredentials.ts', db),
      file('src/storage.ts', unsafe),
    ],
    sources: {
      'src/start.ts': entry,
      'src/publisher.ts': publisher,
      'src/orchard.ts': unrelated,
      'config/dbCredentials.ts': db,
      'src/storage.ts': unsafe,
      'another/not-analyzed.ts': 'createReport ignored only stored source',
    },
    edges: [
      {
        source: 'src/start.ts',
        target: 'src/publisher.ts',
        references: [{ path: 'src/start.ts', startLine: 1, endLine: 1 }],
      },
      {
        source: 'src/start.ts',
        target: 'config/dbCredentials.ts',
        references: [{ path: 'src/start.ts', startLine: 1, endLine: 1 }],
      },
      {
        source: 'src/start.ts',
        target: 'src/storage.ts',
        references: [{ path: 'src/start.ts', startLine: 1, endLine: 1 }],
      },
      {
        source: 'src/start.ts',
        target: 'another/not-analyzed.ts',
        references: [{ path: 'src/start.ts', startLine: 1, endLine: 1 }],
      },
    ],
    entryPoints: [{ path: 'src/start.ts', startLine: 1, endLine: 1 }],
    diagnostics: [],
  };
}

const origin = { name: 'sample', origin: 'local' } as const;

describe('repository context', () => {
  it('ranks symbols and follows verified imports without exposing excluded paths or content', () => {
    const store = openProjectStore(':memory:');
    try {
      const analysis = store.save(origin, fixture());
      const question = 'How does createReport work?';
      const options = { inputTokens: 850 };
      const context = retrieveRepositoryContext(store, analysis, question, options);
      expect(context).toEqual(retrieveRepositoryContext(store, analysis, question, options));
      expect(context.excerpts[0]).toMatchObject({
        id: 'S1',
        path: 'src/start.ts',
        startLine: 1,
        endLine: 6,
      });
      expect(context.excerpts[0].source).toBe(fixture().sources['src/start.ts']);
      expect(context.dependencies).toEqual([
        { source: 'src/start.ts', target: 'src/publisher.ts', evidence: 'S1' },
      ]);
      expect(context.excerpts.map((excerpt) => excerpt.path)).toEqual([
        'src/start.ts',
        'src/publisher.ts',
      ]);
      const serialized = JSON.stringify(context);
      expect(context.estimatedTokens).toBe(estimateRepositoryTokens(serialized));
      expect(context.estimatedTokens).toBeLessThanOrEqual(options.inputTokens);
      expect(serialized).not.toMatch(/dbCredentials|fake-pw-content|not-analyzed/);
    } finally {
      store.close();
    }
  });

  it('matches source text and reuses prior questions for follow-ups', () => {
    const store = openProjectStore(':memory:');
    try {
      const analysis = store.save(origin, fixture());
      const current = retrieveRepositoryContext(store, analysis, 'Where are pears used?', {
        inputTokens: 600,
      });
      expect(current.excerpts[0]?.path).toBe('src/orchard.ts');
      const followUp = retrieveRepositoryContext(store, analysis, 'Can you say more?', {
        inputTokens: 600,
        priorQuestions: ['Explain src/publisher.ts.'],
      });
      expect(followUp.excerpts[0]?.path).toBe('src/publisher.ts');
    } finally {
      store.close();
    }
  });

  it('returns no evidence for an unmatched specific question', () => {
    const store = openProjectStore(':memory:');
    try {
      const analysis = store.save(origin, fixture());
      const context = retrieveRepositoryContext(store, analysis, 'How does hexabind123 work?', {
        inputTokens: 600,
      });
      expect(context.excerpts).toEqual([]);
      expect(context.dependencies).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('uses common Russian architecture terms while retaining literal Unicode matches', () => {
    const store = openProjectStore(':memory:');
    try {
      const auth = 'export function authenticate(user: string) { return Boolean(user); }';
      const source = 'export const label = "черешня";';
      const analysis = store.save(origin, {
        files: [file('src/auth.ts', auth), file('src/fruit.ts', source)],
        sources: { 'src/auth.ts': auth, 'src/fruit.ts': source },
        edges: [],
        entryPoints: [],
        diagnostics: [],
      });
      expect(
        retrieveRepositoryContext(store, analysis, 'Где работает аутентификация?', {
          inputTokens: 600,
        }).excerpts[0]?.path,
      ).toBe('src/auth.ts');
      expect(
        retrieveRepositoryContext(store, analysis, 'Где используется черешня?', {
          inputTokens: 600,
        }).excerpts[0]?.path,
      ).toBe('src/fruit.ts');
    } finally {
      store.close();
    }
  });

  it('fits a small serialized budget without duplicating overlapping evidence', () => {
    const store = openProjectStore(':memory:');
    try {
      const source = Array.from(
        { length: 55 },
        (_, index) => `const focus${index} = "${'字'.repeat(9)}";`,
      ).join('\n');
      const analysis = store.save(origin, {
        files: [file('src/focus.ts', source)],
        sources: { 'src/focus.ts': source },
        edges: [],
        entryPoints: [],
        diagnostics: [],
      });
      const context = retrieveRepositoryContext(store, analysis, 'How is focus used?', {
        inputTokens: 180,
      });
      expect(context.excerpts.length).toBeGreaterThan(0);
      expect(context.estimatedTokens).toBeLessThanOrEqual(180);
      expect(context.estimatedTokens).toBe(estimateRepositoryTokens(JSON.stringify(context)));
      for (const [index, excerpt] of context.excerpts.entries()) {
        expect(excerpt.source).toBe(
          source
            .split('\n')
            .slice(excerpt.startLine - 1, excerpt.endLine)
            .join('\n'),
        );
        const overlapping = context.excerpts
          .slice(index + 1)
          .some(
            (other) => other.startLine <= excerpt.endLine && other.endLine >= excerpt.startLine,
          );
        expect(overlapping).toBe(false);
      }
    } finally {
      store.close();
    }
  });

  it('verifies IDs only against real, unchanged ranges in the same snapshot', () => {
    const store = openProjectStore(':memory:');
    try {
      const analysis = store.save(origin, fixture());
      const context = retrieveRepositoryContext(store, analysis, 'createReport', {
        inputTokens: 650,
      });
      const excerpt = context.excerpts[0];
      expect(excerpt).toBeDefined();
      expect(
        verifyRepositoryCitations(store, analysis, context, ['S1', 'S1', 'S99', 'S01']),
      ).toEqual([excerpt]);
      expect(
        verifyRepositoryCitations(store, store.save(origin, fixture()), context, ['S1']),
      ).toEqual([]);
      expect(
        verifyRepositoryCitations(
          store,
          analysis,
          {
            ...context,
            excerpts: [{ ...excerpt, source: 'tampered' }],
          },
          ['S1'],
        ),
      ).toEqual([]);
      expect(
        verifyRepositoryCitations(
          store,
          analysis,
          {
            ...context,
            excerpts: [{ ...excerpt, endLine: excerpt.endLine + 1 }],
          },
          ['S1'],
        ),
      ).toEqual([]);
      expect(
        verifyRepositoryCitations(
          store,
          analysis,
          {
            ...context,
            excerpts: [excerpt, excerpt],
          },
          ['S1'],
        ),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('reads legacy snapshots through the same retrieval and verification path', async () => {
    const temporary = await realpath(tmpdir());
    const directory = await mkdtemp(join(temporary, 'arqivanta-context-test-'));
    const databasePath = join(directory, 'context.sqlite');
    const store = openProjectStore(databasePath);
    try {
      const { sources, ...metadata } = fixture();
      const project = {
        ...origin,
        id: 'legacy',
        createdAt: new Date().toISOString(),
        fileCount: metadata.files.length,
        edgeCount: metadata.edges.length,
      };
      const analysis: ProjectAnalysis = { ...metadata, project };
      const legacy = new DatabaseSync(databasePath);
      try {
        legacy
          .prepare('INSERT INTO projects VALUES (?, ?, NULL, ?, ?, ?)')
          .run(
            project.id,
            project.createdAt,
            JSON.stringify(project),
            JSON.stringify(analysis),
            JSON.stringify(sources),
          );
      } finally {
        legacy.close();
      }
      const context = retrieveRepositoryContext(store, analysis, 'createReport', {
        inputTokens: 600,
      });
      expect(context.excerpts[0]?.path).toBe('src/start.ts');
      expect(verifyRepositoryCitations(store, analysis, context, ['S1'])).toEqual([
        context.excerpts[0],
      ]);
    } finally {
      store.close();
      const resolved = await realpath(directory);
      if (dirname(resolved) === temporary && resolved === directory)
        await rm(resolved, { recursive: true, force: true });
    }
  });
});

it('recognizes sensitive names, unsafe paths and likely inline credential material', () => {
  for (const path of [
    '.env.production',
    'src/.ssh/source.ts',
    'config/dbCredentials.ts',
    '../a.ts',
    '/src/a.ts',
    'src\\a.ts',
  ]) {
    expect(isSensitiveAiPath(path)).toBe(true);
  }
  expect(isSensitiveAiPath('src/report.ts')).toBe(false);
  expect(hasSensitiveAiSource('const key = process.env.OPENAI_API_KEY;')).toBe(false);
  expect(hasSensitiveAiSource(`const key = 'ghp_${'test0'.repeat(6)}';`)).toBe(true);
  expect(hasSensitiveAiSource('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
});
