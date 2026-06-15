'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  createDocumentStore,
} = require('../src/documentStore');
const {
  createBundleStore,
  inferContentType,
  normalizeBundlePath,
  normalizeUploadBundle,
} = require('../src/bundleStore');

test('bundle paths reject traversal, absolute paths, and reserved Windows names', () => {
  assert.equal(normalizeBundlePath('assets/style.css'), 'assets/style.css');
  assert.throws(() => normalizeBundlePath('../etc/passwd'), /must not contain/);
  assert.throws(() => normalizeBundlePath('/etc/passwd'), /must be relative/);
  assert.throws(() => normalizeBundlePath('C:/secret.txt'), /must be relative/);
  assert.throws(() => normalizeBundlePath('assets\\style.css'), /forward slashes/);
  assert.throws(() => normalizeBundlePath('assets/NUL.txt'), /reserved/);
});

test('bundle payload enforces entrypoint, duplicate path, file count, and byte limits', () => {
  const smallHtml = Buffer.from('<h1>ok</h1>').toString('base64');
  assert.throws(
    () => normalizeUploadBundle({
      files: [{ path: 'assets/style.css', content: smallHtml, encoding: 'base64' }],
    }),
    /entrypoint not found/
  );
  assert.throws(
    () => normalizeUploadBundle({
      files: [
        { path: 'index.html', content: smallHtml, encoding: 'base64' },
        { path: 'index.html', content: smallHtml, encoding: 'base64' },
      ],
    }),
    /duplicate/
  );
  assert.throws(
    () => normalizeUploadBundle({
      files: [
        { path: 'index.html', content: smallHtml, encoding: 'base64' },
        { path: 'assets/style.css', content: smallHtml, encoding: 'base64' },
      ],
    }, { maxFiles: 1 }),
    /file limit/
  );
  assert.throws(
    () => normalizeUploadBundle({
      html: '123456',
    }, { maxBytes: 5 }),
    /byte limit/
  );
});

test('bundle store writes manifest rows and files under doc/revision key scheme', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-bundles-'));
  const dbPath = path.join(root, 'meta.sqlite');
  const documents = createDocumentStore({ dbPath });
  const bundles = createBundleStore({ dbPath, pagesDir: root });
  try {
    documents.ensureAnonymousRevision({
      revId: 'abc123abc123',
      title: 'Bundle',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const manifest = bundles.replaceBundle({
      revId: 'abc123abc123',
      docId: 'anon_abc123abc123',
      entrypoint: 'index.html',
      createdAt: '2026-06-15T00:00:00.000Z',
      files: [
        {
          path: 'index.html',
          bytes: Buffer.from('<link rel="stylesheet" href="assets/style.css">'),
          contentType: inferContentType('index.html'),
          sizeBytes: 48,
        },
        {
          path: 'assets/style.css',
          bytes: Buffer.from('body { color: red; }'),
          contentType: inferContentType('assets/style.css'),
          sizeBytes: 20,
        },
      ],
    });
    assert.equal(manifest.entrypoint, 'index.html');
    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.assets[1].bytesKey, 'anon_abc123abc123/abc123abc123/assets/style.css');
    const asset = bundles.getAsset('abc123abc123', 'assets/style.css');
    assert.equal(asset.contentType, 'text/css; charset=utf-8');
    assert.equal(fs.readFileSync(bundles.resolveAssetFile(asset), 'utf8'), 'body { color: red; }');
  } finally {
    bundles.close();
    documents.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
