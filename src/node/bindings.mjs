import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PagesEvents } from '../worker.mjs';
import { createD1, openDatabase } from './d1.mjs';
import { createFileBucket } from './r2.mjs';

// Node stand-ins for the Cloudflare bindings the Worker expects: PAGES_DB, PAGES_BUCKET, PAGES_EVENTS, and ctx.waitUntil.
export function createNodeBindings({ dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const database = openDatabase(join(dataDir, 'pages.sqlite'));
  const events = new PagesEvents();
  const pending = new Set();
  return {
    env: {
      PAGES_DB: createD1(database),
      PAGES_BUCKET: createFileBucket(join(dataDir, 'files')),
      PAGES_EVENTS: { idFromName: (name) => name, get: () => ({ fetch: (input, init) => events.fetch(new Request(input, init)) }) },
    },
    ctx: {
      waitUntil(promise) {
        const tracked = Promise.resolve(promise)
          .catch((error) => console.error('[pages-node] background task failed', error))
          .finally(() => pending.delete(tracked));
        pending.add(tracked);
      },
    },
    async close() {
      await Promise.all(pending);
      database.close();
    },
  };
}
