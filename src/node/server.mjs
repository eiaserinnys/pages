import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import worker, { assertRequiredEnv } from '../worker.mjs';
import { createNodeBindings } from './bindings.mjs';

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export function createPagesServer({ env: configEnv, dbFile }) {
  const bindings = createNodeBindings({ dbFile });
  const env = { ...configEnv, ...bindings.env };
  assertRequiredEnv(env);
  const origin = new URL(env.BASE_URL).origin;

  const server = createServer(async (incoming, outgoing) => {
    try {
      const response = await worker.fetch(toRequest(incoming, origin), env, bindings.ctx);
      await sendResponse(response, outgoing);
    } catch (error) {
      if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      console.error('[pages-node] request failed', error);
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      outgoing.end('Internal server error');
    }
  });
  server.on('close', () => { bindings.close().catch((error) => console.error('[pages-node] shutdown failed', error)); });
  return server;
}

function toRequest(incoming, origin) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const init = { method: incoming.method, headers };
  if (!BODYLESS_METHODS.has(incoming.method)) {
    init.body = Readable.toWeb(incoming);
    init.duplex = 'half';
  }
  return new Request(new URL(incoming.url, origin), init);
}

async function sendResponse(response, outgoing) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  outgoing.writeHead(response.status, response.statusText || undefined, headers);
  if (!response.body) {
    outgoing.end();
    return;
  }
  outgoing.flushHeaders();
  await pipeline(Readable.fromWeb(response.body), outgoing);
}

function readConfig(processEnv) {
  const envFile = resolve(processEnv.PAGES_ENV_FILE || '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return {
    env: { ...process.env },
    port: Number(process.env.PORT || 3110),
    host: process.env.HOST || '127.0.0.1',
    dbFile: resolve(process.env.PAGES_DB_FILE || 'data/pages.sqlite'),
  };
}

async function main() {
  const { env, port, host, dbFile } = readConfig(process.env);
  const server = createPagesServer({ env, dbFile });
  server.listen(port, host, () => console.log(`[pages-node] listening on http://${host}:${port} (database: ${dbFile})`));
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
