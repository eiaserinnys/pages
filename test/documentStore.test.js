'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createAnnotationStore } = require('../src/annotationStore');
const { createDocumentStore, normalizeSlug } = require('../src/documentStore');

test('document store appends revisions and tracks latest revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-documents-'));
  const store = createDocumentStore({ dbPath: path.join(root, 'meta.sqlite') });
  try {
    const first = store.appendRevision({
      slug: 'phase-two-doc',
      revId: 'aaa111aaa111',
      title: 'Version 1',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    assert.equal(first.revision.revNumber, 1);
    assert.equal(first.latestRevision, 'aaa111aaa111');

    const second = store.appendRevision({
      slug: 'phase-two-doc',
      revId: 'bbb222bbb222',
      title: 'Version 2',
      createdAt: '2026-06-15T01:00:00.000Z',
    });
    assert.equal(second.revision.revNumber, 2);
    assert.equal(second.latestRevision, 'bbb222bbb222');
    assert.deepEqual(second.revisions.map((revision) => revision.revNumber), [2, 1]);
    assert.equal(store.getRevisionBySlugNumber('phase-two-doc', 1).revId, 'aaa111aaa111');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('document store rejects invalid and reserved slugs', () => {
  assert.throws(() => normalizeSlug('Nope'), /must match/);
  assert.throws(() => normalizeSlug('ab'), /must match/);
  assert.throws(() => normalizeSlug('api'), /reserved/);
  assert.equal(normalizeSlug('valid_slug-123'), 'valid_slug-123');
});

test('document store lists named documents by newest update', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-documents-'));
  const store = createDocumentStore({ dbPath: path.join(root, 'meta.sqlite') });
  try {
    store.appendRevision({
      slug: 'older-doc',
      revId: 'aaa111aaa111',
      title: 'Older',
      owner: 'writer-a',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    store.appendRevision({
      slug: 'newer-doc',
      revId: 'bbb222bbb222',
      title: 'Newer v1',
      owner: 'writer-b',
      createdAt: '2026-06-15T01:00:00.000Z',
    });
    store.appendRevision({
      slug: 'newer-doc',
      revId: 'ccc333ccc333',
      title: 'Newer v2',
      owner: 'writer-b',
      createdAt: '2026-06-15T02:00:00.000Z',
    });
    store.ensureAnonymousRevision({
      revId: 'ddd444ddd444',
      title: 'Anonymous',
      createdAt: '2026-06-15T03:00:00.000Z',
    });

    const rows = store.listDocuments();
    assert.deepEqual(rows.map((row) => row.slug), ['newer-doc', 'older-doc']);
    assert.equal(rows[0].title, 'Newer v2');
    assert.equal(rows[0].latestRevision, 'ccc333ccc333');
    assert.equal(rows[0].latestRevNumber, 2);
    assert.equal(rows[0].revisionCount, 2);
    assert.equal(rows[0].owner, 'writer-b');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('comments require an existing revision after document migration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-documents-'));
  const dbPath = path.join(root, 'meta.sqlite');
  const documents = createDocumentStore({ dbPath });
  const annotations = createAnnotationStore({ dbPath });
  try {
    assert.throws(
      () => annotations.replace('missingrev01', {
        schema_version: '1.0',
        comments: [
          {
            id: 'cmt_1',
            comment: 'orphan comment',
          },
        ],
      }),
      /comments\.rev_id must reference revisions\.rev_id/
    );

    documents.ensureAnonymousRevision({
      revId: 'abc123abc123',
      title: 'Anonymous',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    annotations.replace('abc123abc123', {
      schema_version: '1.0',
      comments: [
        {
          id: 'cmt_2',
          comment: 'attached comment',
        },
      ],
    });
    assert.equal(annotations.list('abc123abc123').comments.length, 1);
  } finally {
    annotations.close();
    documents.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
