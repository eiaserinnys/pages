import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import worker, { PagesEvents } from '../src/worker.mjs';
import { createDatabase, createBucket, d1 } from './helpers/workerFixture.mjs';

const BASE_URL = 'https://pages.example.test';
const bundleFiles = [{
  path: 'index.html',
  content: Buffer.from('<html><body>Event body</body></html>', 'utf8').toString('base64'),
  encoding: 'base64',
}];

function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function createEventsNamespace() {
  const hub = new PagesEvents({}, {});
  return {
    hub,
    idFromName: (name) => name,
    get: (id) => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }),
  };
}

function fixture(t, events = createEventsNamespace()) {
  const db = createDatabase();
  t.after(() => db.close());
  const bucket = createBucket();
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const env = {
    PAGES_DB: d1(db),
    PAGES_BUCKET: bucket,
    PAGES_API_TOKEN: 'token',
    SESSION_SECRET: 'secret',
    BASE_URL,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    ALLOWED_EMAILS: 'tester@example.com',
    PAGES_EVENTS: events,
  };
  const cookie = `pages.session=${signSession({ email: 'tester@example.com', exp: Math.floor(Date.now() / 1000) + 60 }, env.SESSION_SECRET)}`;
  const call = (path, options) => worker.fetch(new Request(BASE_URL + path, options), env, ctx);
  const upload = (body) => call('/api/pages', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { bucket, call, upload, cookie, events, pending, settle: () => Promise.all(pending) };
}

async function readFrame(reader) {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.endsWith('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('change events reject unauthenticated connections', { timeout: 60_000 }, async (t) => {
  const { call } = fixture(t);
  const response = await call('/api/events');
  assert.equal(response.status, 401);
});

test('a successful write notifies the open stream once', { timeout: 60_000 }, async (t) => {
  const { call, upload, cookie, settle } = fixture(t);

  const stream = await call('/api/events', { headers: { Cookie: cookie } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel());

  const response = await upload({ doc: 'shared-doc', entrypoint: 'index.html', files: bundleFiles });
  assert.equal(response.status, 201);
  await settle();

  assert.equal(
    await readFrame(reader),
    'event: document_updated\ndata: {"type":"document_updated","id":"shared-doc"}\n\n',
  );
  const extra = await Promise.race([
    reader.read(),
    new Promise((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
  assert.equal(extra, null, 'no additional frame is sent for one write');
});

test('the stream keeps the connection alive every 30 seconds', { timeout: 60_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { call, cookie, events } = fixture(t);

  const stream = await call('/api/events', { headers: { Cookie: cookie } });
  const reader = stream.body.getReader();

  t.mock.timers.tick(30_000);
  assert.equal(await readFrame(reader), ': keepalive\n\n');

  await reader.cancel();
  assert.equal(events.hub.keepaliveTimer, null, 'the keepalive timer stops when the last connection closes');
});

test('a failing notification leaves the write response successful', { timeout: 60_000 }, async (t) => {
  const events = {
    idFromName: (name) => name,
    get() { throw new Error('events unavailable'); },
  };
  const { upload, settle } = fixture(t, events);

  const response = await upload({ doc: 'resilient-doc', entrypoint: 'index.html', files: bundleFiles });
  assert.equal(response.status, 201);
  await settle();
});
