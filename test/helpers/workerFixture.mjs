import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DASHBOARD_HTML_PREVIEW_BYTES } from '../../src/workerDashboard.mjs';
import { createD1, openDatabase } from '../../src/node/d1.mjs';
import { createFileBucket } from '../../src/node/r2.mjs';

function createDatabase() {
  return openDatabase(':memory:');
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
  database.prepare('INSERT INTO webhook_secrets VALUES (?, ?, ?, ?, ?)').run('ccc333ccc333', 'secret', 'secret-hash', '2026-07-20T06:00:00Z', '2026-07-20T06:00:00Z');
  database.prepare('INSERT INTO revision_bundles VALUES (?, ?, ?, ?, ?)').run('ccc333ccc333', 'index.html', 1, 0, '2026-07-20T06:00:00Z');
  database.prepare('INSERT INTO revision_assets VALUES (?, ?, ?, ?, ?, ?)').run(
    'ccc333ccc333',
    'chart.svg',
    'assets/ccc333ccc333/chart.svg',
    'image/svg+xml',
    0,
    '2026-07-20T06:00:00Z',
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

function contentTypeFor(key) {
  if (key.endsWith('.html')) return 'text/html; charset=utf-8';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return undefined;
}

// The real file-backed bucket in a temp folder, plus call logs and seeding helpers for tests.
function createBucket() {
  const root = mkdtempSync(join(tmpdir(), 'pages-bucket-'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  const files = createFileBucket(root);
  const seed = (key, text) => files.putSync(key, text, { httpMetadata: { contentType: contentTypeFor(key) } });
  return {
    reads: [],
    deletes: [],
    puts: [],
    putJson(key, value) { seed(key, JSON.stringify(value)); },
    putText(key, value) { seed(key, value); },
    async put(key, value, options) {
      this.puts.push({ key, options });
      return files.put(key, value, options);
    },
    async get(key, options) {
      this.reads.push({ key, options });
      return files.get(key, options);
    },
    async delete(keys) {
      this.deletes.push(...(Array.isArray(keys) ? keys : [keys]));
      return files.delete(keys);
    },
  };
}

const d1 = createD1;

export { createDatabase, createBucket, d1, seedDatabase, seedBucket };
