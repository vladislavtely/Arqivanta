import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const databaseDir = resolve(process.env.ARQIVANTA_DATA_DIR ?? resolve(workspace, '.arqivanta'));
const webRoot = resolve(workspace, 'apps/web/dist');
const apiPort = Number(process.env.ARQIVANTA_PORT ?? 4317);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) {
  throw new Error('ARQIVANTA_PORT must be an integer from 1024 to 65535.');
}
await mkdir(databaseDir, { recursive: true, mode: 0o700 });

const app = createApp({
  database: resolve(databaseDir, 'projects.sqlite'),
  exampleRoot: resolve(workspace, 'examples/field-notes'),
  webRoot: existsSync(resolve(webRoot, 'index.html')) ? webRoot : undefined,
  apiPort,
});

process.once('SIGINT', () => void app.close());
process.once('SIGTERM', () => void app.close());
console.log(`Arqivanta is listening at ${await app.listen({ host: '127.0.0.1', port: apiPort })}`);
