import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.mjs';
import { createDatabase, createBucket, d1, seedDatabase, seedBucket } from './helpers/workerFixture.mjs';

const BASE_URL = 'https://pages.example.test';

function fixture(t) {
  const db = createDatabase();
  t.after(() => db.close());
  seedDatabase(db);
  const bucket = createBucket();
  seedBucket(bucket);
  const env = {
    PAGES_DB: d1(db),
    PAGES_BUCKET: bucket,
    PAGES_API_TOKEN: 'token',
    SESSION_SECRET: 'secret',
    BASE_URL,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    ALLOWED_EMAILS: 'tester@example.com',
  };
  const call = (path) => worker.fetch(new Request(BASE_URL + path), env, { waitUntil() {} });
  return { bucket, call };
}

test('unknown document slug returns 404', { timeout: 60_000 }, async (t) => {
  const { call } = fixture(t);
  assert.equal((await call('/d/no-such-doc/')).status, 404);
  assert.equal((await call('/d/no-such-doc')).status, 404);
});

test('page without revision meta returns 404', { timeout: 60_000 }, async (t) => {
  const { call } = fixture(t);
  assert.equal((await call('/p/123456789abc/')).status, 404);
});

test('legacy page without a bundle is served from its stored html', { timeout: 60_000 }, async (t) => {
  const { bucket, call } = fixture(t);
  const page = await call('/p/eee555eee555/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Alpha v1/);

  bucket.putText('pages/fff666fff666.html', '<html><body>Percent legacy</body></html>');
  const stable = await call('/d/percent-doc/');
  assert.equal(stable.status, 200);
  assert.match(await stable.text(), /Percent legacy/);
  assert.equal((await call('/d/percent-doc/missing.css')).status, 404);
});

test('private document API rejects anonymous readers', { timeout: 60_000 }, async (t) => {
  const { call } = fixture(t);
  const denied = await call('/api/documents/alpha-doc');
  assert.equal(denied.status, 401);
  const open = await call('/api/documents/beta-doc');
  assert.equal(open.status, 200);
  assert.equal((await open.json()).title, 'Beta Report');
});
