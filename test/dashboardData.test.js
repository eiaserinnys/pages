'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createDashboardService,
  extractUnfurl,
  paginateForDashboard,
} = require('../src/dashboardData');

test('dashboard pagination filters before applying an offset cursor', () => {
  const result = paginateForDashboard([
    { title: 'Alpha', slug: 'alpha-doc' },
    { title: 'Beta', slug: 'alpha-notes' },
    { title: 'Gamma', slug: 'gamma-doc' },
  ], {
    cursor: '1',
    limit: '1',
    q: 'ALPHA',
    searchFields: ['title', 'slug'],
  });

  assert.deepEqual(result.items, [{ title: 'Beta', slug: 'alpha-notes' }]);
  assert.equal(result.total, 2);
  assert.equal(result.cursor, 1);
  assert.equal(result.nextCursor, null);
  assert.equal(result.hasMore, false);
  assert.equal(result.query, 'ALPHA');
});

test('dashboard pagination bounds malformed inputs and exposes the next cursor', () => {
  const items = Array.from({ length: 60 }, (_, index) => ({ title: `Item ${index}` }));
  const result = paginateForDashboard(items, {
    cursor: '-4',
    limit: '999',
    q: '',
    searchFields: ['title'],
  });

  assert.equal(result.cursor, 0);
  assert.equal(result.limit, 50);
  assert.equal(result.items.length, 50);
  assert.equal(result.nextCursor, 50);
  assert.equal(result.hasMore, true);
});

test('unfurl extraction prefers Open Graph metadata and resolves relative images', () => {
  const unfurl = extractUnfurl(`<!doctype html>
    <html><head>
      <title>Document title</title>
      <meta content="OG title" property="og:title">
      <meta name="description" content="Plain description">
      <meta property="og:description" content="OG &amp; description">
      <meta content="assets/card.png" property="og:image">
    </head></html>`, {
    url: 'https://pages.example.test/d/alpha-doc/',
    fallbackTitle: 'Fallback',
  });

  assert.deepEqual(unfurl, {
    title: 'OG title',
    description: 'OG & description',
    image: 'https://pages.example.test/d/alpha-doc/assets/card.png',
    url: 'https://pages.example.test/d/alpha-doc/',
  });
});

test('unfurl extraction bounds metadata and leaves invalid numeric entities intact', () => {
  const unfurl = extractUnfurl(`<html><head>
    <title>&#999999999;${'T'.repeat(400)}</title>
    <meta name="description" content="${'D'.repeat(1200)}">
  </head></html>`, {
    url: 'https://pages.example.test/p/aaa111aaa111/',
    fallbackTitle: 'Fallback',
  });

  assert.equal(unfurl.title.startsWith('&#999999999;'), true);
  assert.equal(unfurl.title.length, 300);
  assert.equal(unfurl.description.length, 1000);
});

test('dashboard service builds searchable lists and document detail with revision history', () => {
  const documents = {
    listDocuments() {
      return [
        {
          slug: 'alpha-doc',
          title: 'Alpha report',
          owner: 'writer',
          latestRevision: 'aaa111aaa111',
          latestRevNumber: 2,
          latestRevCreatedAt: '2026-07-20T02:00:00.000Z',
          revisionCount: 2,
          createdAt: '2026-07-20T01:00:00.000Z',
          updatedAt: '2026-07-20T02:00:00.000Z',
        },
      ];
    },
    getDocument(slug) {
      if (slug !== 'alpha-doc') return null;
      return {
        docId: 'doc_alpha',
        slug,
        title: 'Alpha report',
        owner: 'writer',
        latestRevision: 'aaa111aaa111',
        createdAt: '2026-07-20T01:00:00.000Z',
        updatedAt: '2026-07-20T02:00:00.000Z',
        revisions: [
          { revId: 'aaa111aaa111', revNumber: 2, status: 'published', createdAt: '2026-07-20T02:00:00.000Z' },
          { revId: 'bbb222bbb222', revNumber: 1, status: 'published', createdAt: '2026-07-20T01:00:00.000Z' },
        ],
      };
    },
  };
  const metas = new Map([
    ['aaa111aaa111', { id: 'aaa111aaa111', title: 'Alpha latest', private: true, reviewable: true }],
    ['bbb222bbb222', { id: 'bbb222bbb222', title: 'Alpha first', private: false }],
    ['ccc333ccc333', { id: 'ccc333ccc333', title: 'One-off', private: false, createdAt: '2026-07-20T03:00:00.000Z' }],
  ]);
  const pageStorage = {
    listMetas: () => [...metas.values()],
    readMeta: (id) => metas.get(id) || null,
    readHtml: (id) => id === 'aaa111aaa111'
      ? '<html><head><title>Alpha preview</title><meta name="description" content="Summary"></head></html>'
      : '<html></html>',
  };
  const annotations = {
    countByRevisionIds: () => ({ aaa111aaa111: 2 }),
    list: () => ({ comments: [] }),
  };
  const service = createDashboardService({
    documents,
    pageStorage,
    annotations,
    baseUrl: 'https://pages.example.test',
  });

  const list = service.listDocuments({ q: 'alpha', cursor: 0, limit: 24 });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].private, true);

  const pages = service.listPages({ q: 'one', cursor: 0, limit: 24 });
  assert.deepEqual(pages.items.map((item) => item.id), ['ccc333ccc333']);

  const detail = service.getDocumentDetail('alpha-doc');
  assert.equal(detail.kind, 'documents');
  assert.equal(detail.private, true);
  assert.equal(detail.url, 'https://pages.example.test/d/alpha-doc/');
  assert.equal(detail.unfurl.title, 'Alpha preview');
  assert.equal(detail.revisions.length, 2);
  assert.equal(detail.revisions[0].commentCount, 2);
  assert.equal(detail.revisions[0].url, 'https://pages.example.test/d/alpha-doc/r/2/');
});
