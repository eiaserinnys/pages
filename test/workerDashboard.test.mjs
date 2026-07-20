import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import worker from '../src/worker.mjs';
import {
  DASHBOARD_HTML_PREVIEW_BYTES,
  dashboardQuery,
  getDashboardDocumentDetail,
  getDashboardPageDetail,
  listDashboardDocuments,
  listDashboardPages,
} from '../src/workerDashboard.mjs';

test('Worker dashboard query normalizes cursor, limit, and search', () => {
  const query = dashboardQuery(new Request('https://pages.example.test/api/dashboard/documents?cursor=-1&limit=999&q=%20Alpha%20'));
  assert.deepEqual(query, { cursor: 0, limit: 50, q: 'Alpha' });
});

test('Worker dashboard uses D1 cursor search and R2 range unfurl without migrations', async () => {
  const database = createDatabase();
  const bucket = createBucket();
  const env = { PAGES_DB: d1(database), PAGES_BUCKET: bucket };
  seedDatabase(database);
  seedBucket(bucket);

  const first = await listDashboardDocuments(env, { cursor: 0, limit: 1, q: '' });
  assert.equal(first.total, 3);
  assert.deepEqual(first.items.map((item) => item.slug), ['alpha-doc']);
  assert.equal(first.items[0].private, true);
  assert.equal(first.nextCursor, 1);

  const second = await listDashboardDocuments(env, { cursor: first.nextCursor, limit: 1, q: '' });
  assert.deepEqual(second.items.map((item) => item.slug), ['percent-doc']);

  const literalWildcard = await listDashboardDocuments(env, { cursor: 0, limit: 24, q: '%' });
  assert.deepEqual(literalWildcard.items.map((item) => item.slug), ['percent-doc']);

  const pages = await listDashboardPages(env, { cursor: 0, limit: 24, q: 'alpha' });
  assert.equal(pages.total, 1);
  assert.equal(pages.items[0].id, 'ccc333ccc333');
  assert.equal(pages.items[0].private, false);

  const document = await getDashboardDocumentDetail(env, 'alpha-doc', 'https://pages.example.test');
  assert.equal(document.kind, 'documents');
  assert.equal(document.private, true);
  assert.equal(document.unfurl.title, 'Alpha OG');
  assert.equal(document.unfurl.image, 'https://pages.example.test/d/alpha-doc/card.png');
  assert.deepEqual(document.revisions.map((revision) => revision.commentCount), [2, 0]);
  assert.equal(document.revisions[0].url, 'https://pages.example.test/d/alpha-doc/r/2/');

  const page = await getDashboardPageDetail(env, 'ccc333ccc333', 'https://pages.example.test');
  assert.equal(page.kind, 'pages');
  assert.equal(page.unfurl.title, 'One-off Alpha');
  assert.equal(page.url, 'https://pages.example.test/p/ccc333ccc333/');

  const htmlReads = bucket.reads.filter((read) => read.key.endsWith('.html'));
  assert.equal(htmlReads.length, 2);
  assert.deepEqual(htmlReads.map((read) => read.options), [
    { range: { offset: 0, length: DASHBOARD_HTML_PREVIEW_BYTES } },
    { range: { offset: 0, length: DASHBOARD_HTML_PREVIEW_BYTES } },
  ]);

  database.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'doc-damaged',
    'damaged-doc',
    'Damaged Document',
    'writer',
    '999999999999',
    '2026-07-19T01:00:00Z',
    '2026-07-19T01:00:00Z',
  );
  database.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?)').run(
    '999999999999',
    'doc-damaged',
    1,
    'published',
    '2026-07-19T01:00:00Z',
  );
  database.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'anon-damaged',
    null,
    'Damaged Page',
    'api',
    '888888888888',
    '2026-07-19T01:00:00Z',
    '2026-07-19T01:00:00Z',
  );
  database.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?)').run(
    '888888888888',
    'anon-damaged',
    1,
    'published',
    '2026-07-19T01:00:00Z',
  );
  bucket.putText('pages/999999999999.json', '{invalid');
  bucket.putText('pages/888888888888.json', '{invalid');

  const damagedDocuments = await listDashboardDocuments(env, { cursor: 0, limit: 24, q: 'damaged' });
  const damagedPages = await listDashboardPages(env, { cursor: 0, limit: 24, q: 'damaged' });
  assert.deepEqual(damagedDocuments.items, []);
  assert.deepEqual(damagedPages.items, []);
  assert.equal(damagedDocuments.nextCursor, null);
  assert.equal(damagedPages.nextCursor, null);
  database.close();
});

test('Worker routes protect and render the modern dashboard and detail APIs', async () => {
  const database = createDatabase();
  const bucket = createBucket();
  seedDatabase(database);
  seedBucket(bucket);
  const env = {
    PAGES_DB: d1(database),
    PAGES_BUCKET: bucket,
    PAGES_API_TOKEN: 'test-token',
    SESSION_SECRET: 'worker-session-secret',
    BASE_URL: 'https://pages.example.test',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    ALLOWED_EMAILS: 'tester@example.com',
  };
  const unauthenticated = await worker.fetch(
    new Request('https://pages.example.test/api/dashboard/documents/alpha-doc'),
    env,
    { waitUntil() {} },
  );
  assert.equal(unauthenticated.status, 302);
  assert.equal(unauthenticated.headers.get('location'), '/auth/google?returnTo=%2Fapi%2Fdashboard%2Fdocuments%2Falpha-doc');

  const cookie = `pages.session=${signSession({ email: 'tester@example.com', exp: Math.floor(Date.now() / 1000) + 60 }, env.SESSION_SECRET)}`;
  const dashboard = await worker.fetch(
    new Request('https://pages.example.test/dashboard', { headers: { Cookie: cookie } }),
    env,
    { waitUntil() {} },
  );
  const dashboardHtml = await dashboard.text();
  assert.equal(dashboard.status, 200);
  assert.match(dashboardHtml, /data-detail-panel/);
  assert.match(dashboardHtml, /data-tab="documents"/);
  assert.doesNotMatch(dashboardHtml, /data-page-action/);

  const detail = await worker.fetch(
    new Request('https://pages.example.test/api/dashboard/pages/ccc333ccc333', { headers: { Cookie: cookie } }),
    env,
    { waitUntil() {} },
  );
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).unfurl.title, 'One-off Alpha');

  const malformedSlug = await worker.fetch(
    new Request('https://pages.example.test/api/dashboard/documents/%E0%A4%A', { headers: { Cookie: cookie } }),
    env,
    { waitUntil() {} },
  );
  assert.equal(malformedSlug.status, 404);

  const deleted = await worker.fetch(
    new Request('https://pages.example.test/api/pages/ccc333ccc333', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }),
    env,
    { waitUntil() {} },
  );
  assert.equal(deleted.status, 204);

  const remaining = await listDashboardPages(env, { cursor: 0, limit: 24, q: '' });
  assert.equal(remaining.total, 1);
  assert.deepEqual(remaining.items.map((item) => item.id), ['ddd444ddd444']);
  assert.deepEqual(bucket.deletes.sort(), [
    'assets/ccc333ccc333/chart.svg',
    'pages/ccc333ccc333.html',
    'pages/ccc333ccc333.json',
  ]);
  database.close();
});

function createDatabase() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY, slug TEXT UNIQUE, title TEXT NOT NULL, owner TEXT NOT NULL,
      latest_revision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE revisions (
      rev_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, rev_number INTEGER NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE comments (
      comment_id TEXT PRIMARY KEY, rev_id TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE webhook_secrets (
      rev_id TEXT PRIMARY KEY, secret TEXT NOT NULL
    );
    CREATE TABLE revision_bundles (
      rev_id TEXT PRIMARY KEY, entrypoint TEXT NOT NULL
    );
    CREATE TABLE revision_assets (
      rev_id TEXT NOT NULL, path TEXT NOT NULL, bytes_key TEXT NOT NULL,
      PRIMARY KEY (rev_id, path)
    );
  `);
  return database;
}

function seedDatabase(database) {
  const insertDocument = database.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertDocument.run('doc-alpha', 'alpha-doc', 'Alpha Report', 'writer', 'aaa111aaa111', '2026-07-20T01:00:00Z', '2026-07-20T05:00:00Z');
  insertDocument.run('doc-percent', 'percent-doc', '100% Notes', 'writer', 'fff666fff666', '2026-07-20T01:00:00Z', '2026-07-20T04:00:00Z');
  insertDocument.run('doc-beta', 'beta-doc', 'Beta Report', 'writer', 'bbb222bbb222', '2026-07-20T01:00:00Z', '2026-07-20T03:00:00Z');
  insertDocument.run('anon-ccc', null, 'One-off Alpha', 'api', 'ccc333ccc333', '2026-07-20T01:00:00Z', '2026-07-20T06:00:00Z');
  insertDocument.run('anon-ddd', null, 'Other Page', 'api', 'ddd444ddd444', '2026-07-20T01:00:00Z', '2026-07-20T02:00:00Z');

  const insertRevision = database.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?)');
  insertRevision.run('aaa111aaa111', 'doc-alpha', 2, 'published', '2026-07-20T05:00:00Z');
  insertRevision.run('eee555eee555', 'doc-alpha', 1, 'published', '2026-07-20T01:00:00Z');
  insertRevision.run('fff666fff666', 'doc-percent', 1, 'published', '2026-07-20T04:00:00Z');
  insertRevision.run('bbb222bbb222', 'doc-beta', 1, 'published', '2026-07-20T03:00:00Z');
  insertRevision.run('ccc333ccc333', 'anon-ccc', 1, 'published', '2026-07-20T06:00:00Z');
  insertRevision.run('ddd444ddd444', 'anon-ddd', 1, 'published', '2026-07-20T02:00:00Z');
  database.prepare('INSERT INTO comments VALUES (?, ?, ?)').run('comment-1', 'aaa111aaa111', 'One');
  database.prepare('INSERT INTO comments VALUES (?, ?, ?)').run('comment-2', 'aaa111aaa111', 'Two');
  database.prepare('INSERT INTO comments VALUES (?, ?, ?)').run('comment-page', 'ccc333ccc333', 'Page note');
  database.prepare('INSERT INTO webhook_secrets VALUES (?, ?)').run('ccc333ccc333', 'secret');
  database.prepare('INSERT INTO revision_bundles VALUES (?, ?)').run('ccc333ccc333', 'index.html');
  database.prepare('INSERT INTO revision_assets VALUES (?, ?, ?)').run(
    'ccc333ccc333',
    'chart.svg',
    'assets/ccc333ccc333/chart.svg',
  );
}

function seedBucket(bucket) {
  bucket.putJson('pages/aaa111aaa111.json', { id: 'aaa111aaa111', title: 'Alpha Report', private: true, reviewable: true });
  bucket.putJson('pages/eee555eee555.json', { id: 'eee555eee555', title: 'Alpha v1', private: false });
  bucket.putJson('pages/fff666fff666.json', { id: 'fff666fff666', title: '100% Notes', private: false });
  bucket.putJson('pages/bbb222bbb222.json', { id: 'bbb222bbb222', title: 'Beta Report', private: false });
  bucket.putJson('pages/ccc333ccc333.json', { id: 'ccc333ccc333', title: 'One-off Alpha', createdAt: '2026-07-20T06:00:00Z', private: false });
  bucket.putJson('pages/ddd444ddd444.json', { id: 'ddd444ddd444', title: 'Other Page', private: true });
  bucket.putText('pages/aaa111aaa111.html', '<html><head><meta property="og:title" content="Alpha OG"><meta property="og:image" content="card.png"></head></html>' + 'x'.repeat(DASHBOARD_HTML_PREVIEW_BYTES));
  bucket.putText('pages/ccc333ccc333.html', '<html><head><title>One-off Alpha</title></head></html>');
  bucket.putText('assets/ccc333ccc333/chart.svg', '<svg></svg>');
}

function d1(database) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...nextValues) { values = nextValues; return this; },
        async first() { return database.prepare(sql).get(...values) || null; },
        async all() { return { results: database.prepare(sql).all(...values) }; },
        async run() { return { success: true, meta: database.prepare(sql).run(...values) }; },
        _run() { return { success: true, meta: database.prepare(sql).run(...values) }; },
      };
      return statement;
    },
    async batch(statements) {
      const execute = database.transaction(() => statements.map((statement) => statement._run()));
      return execute();
    },
  };
}

function createBucket() {
  const values = new Map();
  return {
    reads: [],
    deletes: [],
    putJson(key, value) { values.set(key, new TextEncoder().encode(JSON.stringify(value))); },
    putText(key, value) { values.set(key, new TextEncoder().encode(value)); },
    async get(key, options) {
      this.reads.push({ key, options });
      const stored = values.get(key);
      if (!stored) return null;
      const range = options?.range;
      const bytes = range ? stored.slice(range.offset, range.offset + range.length) : stored;
      return {
        async text() { return new TextDecoder().decode(bytes); },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      };
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const value of keys) {
        this.deletes.push(value);
        values.delete(value);
      }
    },
  };
}

function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
