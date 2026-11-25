import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import worker from '../../src/worker.mjs';
import { createDatabase, createBucket, d1 } from './workerFixture.mjs';

export const BASE_URL = 'https://pages.example.test';

// Loads the browser reference client into this Node process (it is a plain script).
(0, eval)(readFileSync(new URL('../../client/pagesDocState.js', import.meta.url), 'utf8'));
export const PagesDocState = globalThis.PagesDocState;

export function fixture(t) {
  const db = createDatabase();
  t.after(() => db.close());
  const env = {
    PAGES_DB: d1(db),
    PAGES_BUCKET: createBucket(),
    PAGES_API_TOKEN: 'token',
    SESSION_SECRET: 'secret',
    BASE_URL,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    ALLOWED_EMAILS: 'tester@example.com',
  };
  const call = (path, options) => worker.fetch(new Request(BASE_URL + path, options), env, { waitUntil() {} });
  const upload = (body) => call('/api/pages', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const stateRow = (slug) => db.prepare(`
    SELECT s.* FROM document_state s JOIN documents d ON d.doc_id = s.doc_id WHERE d.slug = ?
  `).get(slug);
  return { db, env, call, upload, stateRow };
}

export function markerHtml(config) {
  const marker = config === null ? '' : `<script type="application/json" id="pages-doc-state">${JSON.stringify(config)}</script>`;
  return `<html><head>${marker}</head><body>doc</body></html>`;
}

// Builds a marker for a made-up password (never a real one).
export async function makeMarker(password, { salt, iter = 10000 } = {}) {
  const saltBytes = salt ? Buffer.from(salt, 'base64') : crypto.getRandomValues(new Uint8Array(16));
  const config = { v: 1, iter, salt: Buffer.from(saltBytes).toString('base64') };
  const keys = await PagesDocState.deriveKeys(password, config);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Buffer.from(keys.writeKey, 'base64url')));
  config.verifier = Buffer.from(digest).toString('base64url');
  return { config, keys };
}

export function stateUrl(slug) {
  return `/api/documents/${slug}/state`;
}

export function workerFetchFor(call) {
  return (url, init) => call(String(url).replace(BASE_URL, ''), init);
}
