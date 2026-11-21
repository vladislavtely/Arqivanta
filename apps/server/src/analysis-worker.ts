import { parentPort, workerData } from 'node:worker_threads';
import { analyzeRepository } from '@arqivanta/analyzer-typescript';

if (!parentPort) throw new Error('Analysis must run in a worker.');

try {
  parentPort.postMessage({ result: await analyzeRepository(workerData as string) });
} catch {
  parentPort.postMessage({ result: undefined });
}
