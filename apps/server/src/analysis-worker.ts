import { parentPort, workerData } from 'node:worker_threads';
import { analyzeRepository, type ParseBaseline } from '@arqivanta/analyzer';

if (!parentPort) throw new Error('Analysis must run in a worker.');

try {
  const { root, baseline } = workerData as { root: string; baseline?: ParseBaseline };
  parentPort.postMessage({ result: await analyzeRepository(root, { baseline }) });
} catch {
  parentPort.postMessage({ result: undefined });
}
