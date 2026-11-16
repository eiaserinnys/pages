import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.mjs';
import { createDatabase, createBucket, d1 } from './helpers/workerFixture.mjs';

const BASE_URL = 'https://pages.example.test';
const bundleFiles = [{
  path: 'index.html',
  content: Buffer.from('<html><body>Document body</body></html>', 'utf8').toString('base64'),
  encoding: 'base64',
}];

function fixture(t) {
  const db = createDatabase();
  t.after(() => db.close());
  const bucket = createBucket();
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
  const call = (path, options) => worker.fetch(new Request(BASE_URL + path, options), env, { waitUntil() {} });
  const upload = (body) => call('/api/pages', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { bucket, call, upload };
}

async function readRevisionMeta(bucket, id) {
  const object = await bucket.get(`pages/${id}.json`);
  assert.ok(object, `revision meta for ${id} exists`);
  return JSON.parse(await object.text());
}

test('re-upload inherits the previous revision privacy when private is omitted', { timeout: 60_000 }, async (t) => {
  const { bucket, call, upload } = fixture(t);

  const first = await upload({ doc: 'shared-doc', private: true, entrypoint: 'index.html', files: bundleFiles });
  assert.equal(first.status, 201);
  assert.equal((await first.json()).private, true);

  const inherited = await upload({ doc: 'shared-doc', entrypoint: 'index.html', files: bundleFiles });
  assert.equal(inherited.status, 201);
  const inheritedBody = await inherited.json();
  assert.equal(inheritedBody.private, true);
  assert.equal((await readRevisionMeta(bucket, inheritedBody.id)).private, true);

  const denied = await call('/d/shared-doc/');
  assert.equal(denied.status, 302);
  assert.match(denied.headers.get('Location') || '', /^\/auth\/google/);

  const opened = await upload({ doc: 'shared-doc', private: false, entrypoint: 'index.html', files: bundleFiles });
  assert.equal(opened.status, 201);
  const openedBody = await opened.json();
  assert.equal(openedBody.private, false);
  assert.equal((await readRevisionMeta(bucket, openedBody.id)).private, false);

  const visible = await call('/d/shared-doc/');
  assert.equal(visible.status, 200);

  const reInherited = await upload({ doc: 'shared-doc', entrypoint: 'index.html', files: bundleFiles });
  assert.equal(reInherited.status, 201);
  assert.equal((await reInherited.json()).private, false);
});

test('a new document uploaded without private stays public', { timeout: 60_000 }, async (t) => {
  const { call, upload } = fixture(t);

  const response = await upload({ doc: 'fresh-doc', entrypoint: 'index.html', files: bundleFiles });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.private, false);

  const visible = await call('/d/fresh-doc/');
  assert.equal(visible.status, 200);
});
