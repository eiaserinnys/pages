import { DASHBOARD_HTML_PREVIEW_BYTES } from '../../src/workerDashboard.mjs';
import Database from 'better-sqlite3';
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
      comment_id TEXT PRIMARY KEY, rev_id TEXT NOT NULL, anchor TEXT NOT NULL,
      body TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE webhook_secrets (
      rev_id TEXT PRIMARY KEY, secret TEXT NOT NULL
    );
    CREATE TABLE revision_bundles (
      rev_id TEXT PRIMARY KEY, entrypoint TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0,
      total_size_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE revision_assets (
      rev_id TEXT NOT NULL, path TEXT NOT NULL, bytes_key TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '',
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
  const insertComment = database.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertComment.run('comment-1', 'aaa111aaa111', '{}', 'One', 'tester', '2026-07-20T05:01:00Z', 0, '{"id":"comment-1","body":"One"}', '2026-07-20T05:01:00Z');
  insertComment.run('comment-2', 'aaa111aaa111', '{}', 'Two', 'tester', '2026-07-20T05:02:00Z', 0, '{"id":"comment-2","body":"Two"}', '2026-07-20T05:02:00Z');
  insertComment.run('comment-page', 'ccc333ccc333', '{}', 'Page note', 'tester', '2026-07-20T06:01:00Z', 0, '{"id":"comment-page","body":"Page note"}', '2026-07-20T06:01:00Z');
  database.prepare('INSERT INTO webhook_secrets VALUES (?, ?)').run('ccc333ccc333', 'secret');
  database.prepare('INSERT INTO revision_bundles (rev_id, entrypoint) VALUES (?, ?)').run('ccc333ccc333', 'index.html');
  database.prepare('INSERT INTO revision_assets (rev_id, path, bytes_key) VALUES (?, ?, ?)').run(
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
  bucket.putText('pages/eee555eee555.html', '<html><head><title>Alpha v1</title></head><body>Alpha v1</body></html>');
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
    puts: [],
    putJson(key, value) { values.set(key, new TextEncoder().encode(JSON.stringify(value))); },
    putText(key, value) { values.set(key, new TextEncoder().encode(value)); },
    async put(key, value, options) {
      const bytes = typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      this.puts.push({ key, options });
      values.set(key, bytes);
    },
    async get(key, options) {
      this.reads.push({ key, options });
      const stored = values.get(key);
      if (!stored) return null;
      const range = options?.range;
      const bytes = range ? stored.slice(range.offset, range.offset + range.length) : stored;
      return {
        body: bytes,
        size: bytes.byteLength,
        httpMetadata: { contentType: key.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' },
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


export { createDatabase, createBucket, d1, seedDatabase, seedBucket };
