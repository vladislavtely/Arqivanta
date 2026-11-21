import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resourceUsage } from 'node:process';
import { analyzeRepository } from '../packages/analyzer/src/index.ts';
import { openProjectStore } from '../packages/core/src/index.ts';

const count = Number(process.argv[2] ?? 2000);
if (!Number.isInteger(count) || count < 2 || count > 20_000) {
  throw new Error('Use a file count between 2 and 20,000.');
}

const temporaryDirectory = await realpath(tmpdir());
const root = await mkdtemp(join(temporaryDirectory, 'arqivanta-benchmark-'));
const groupSize = 100;
const operations = Array.from({ length: 24 }, (_, index) => `  value += ${index};`).join('\n');
const fileName = (index) => `file-${String(index).padStart(5, '0')}.ts`;
const groupName = (index) => `group-${String(index).padStart(3, '0')}`;

async function benchmarkApi() {
  const { createApp } = await import('../apps/server/src/app.ts');
  const app = createApp({ database: ':memory:', exampleRoot: root });
  try {
    const start = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { host: '127.0.0.1:4317' },
      payload: { path: root },
    });
    if (response.statusCode !== 200) throw new Error(response.body);
    const { project, diagnostics } = response.json();
    return {
      analyzedFiles: project.fileCount,
      edges: project.edgeCount,
      apiImportMs: Math.round(performance.now() - start),
      diagnostics: diagnostics.length,
    };
  } finally {
    await app.close();
  }
}

async function benchmarkAnalyzer() {
  const store = openProjectStore(':memory:');
  try {
    const start = performance.now();
    const analysis = await analyzeRepository(root);
    const analyzedAt = performance.now();
    const snapshot = store.save({ name: 'Benchmark', origin: 'local' }, analysis);
    const storedAt = performance.now();
    for (let index = 0; index < 100; index++) {
      const { path } = analysis.files[Math.floor((index * analysis.files.length) / 100)];
      if (store.source(snapshot.project.id, path) === undefined) {
        throw new Error(`Source lookup failed for ${path}.`);
      }
    }
    return {
      analyzedFiles: snapshot.project.fileCount,
      edges: snapshot.project.edgeCount,
      analysisMs: Math.round(analyzedAt - start),
      persistenceMs: Math.round(storedAt - analyzedAt),
      sourceReadsMs: Number((performance.now() - storedAt).toFixed(1)),
    };
  } finally {
    store.close();
  }
}

try {
  for (let start = 0; start < count; start += groupSize) {
    const group = groupName(start / groupSize);
    const directory = join(root, group);
    await mkdir(directory);
    const writes = [];
    for (let index = start; index < Math.min(start + groupSize, count); index++) {
      const source =
        index === 0
          ? 'export const seed = 1;\n'
          : `import { seed as previous } from '../${groupName(Math.floor((index - 1) / groupSize))}/${fileName(index - 1)}';\n` +
            `export const seed = previous + 1;\nexport function calculate(value: number) {\n${operations}\n  return value + seed;\n}\n`;
      writes.push(writeFile(join(directory, fileName(index)), source));
    }
    await Promise.all(writes);
  }

  const metrics = await (process.argv.includes('--api') ? benchmarkApi() : benchmarkAnalyzer());
  console.log(
    JSON.stringify(
      {
        requestedFiles: count,
        ...metrics,
        peakRssMiB: Number((resourceUsage().maxRSS / 1024).toFixed(1)),
      },
      null,
      2,
    ),
  );
} finally {
  const resolved = await realpath(root);
  if (dirname(resolved) === temporaryDirectory && resolved === root) {
    await rm(resolved, { recursive: true, force: true });
  }
}
