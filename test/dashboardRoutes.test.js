'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createDashboardRouter } = require('../src/dashboardRoutes');

test('dashboard router exposes list, detail, and dashboard HTML through one auth boundary', async () => {
  const calls = [];
  const batch = {
    items: [],
    total: 0,
    cursor: 0,
    limit: 24,
    nextCursor: null,
    hasMore: false,
    query: '',
  };
  const service = {
    listDocuments(query) {
      calls.push(['documents', query]);
      return { ...batch, query: query.q || '' };
    },
    listPages(query) {
      calls.push(['pages', query]);
      return batch;
    },
    getDocumentDetail(slug, options) {
      if (slug !== 'alpha-doc') return null;
      return {
        kind: 'documents',
        slug,
        title: 'Alpha',
        owner: 'writer',
        latestRevision: 'aaa111aaa111',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T01:00:00.000Z',
        revisions: [],
        includeComments: options?.includeComments === true,
      };
    },
    getPageDetail(id) {
      return id === 'bbb222bbb222'
        ? { kind: 'pages', id, title: 'Page', private: false, revisions: [] }
        : null;
    },
  };
  const app = express();
  let authChecks = 0;
  app.use(createDashboardRouter({
    requireAuth(req, res, next) {
      authChecks += 1;
      next();
    },
    service,
    baseUrl: 'https://pages.example.test',
  }));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const list = await fetch(`${baseUrl}/api/dashboard/documents?cursor=4&limit=12&q=alpha`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).query, 'alpha');
    assert.deepEqual(calls[0], ['documents', { cursor: '4', limit: '12', q: 'alpha' }]);

    const detail = await fetch(`${baseUrl}/api/dashboard/documents/alpha-doc`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).slug, 'alpha-doc');

    const pageDetail = await fetch(`${baseUrl}/api/dashboard/pages/bbb222bbb222`);
    assert.equal(pageDetail.status, 200);
    assert.equal((await pageDetail.json()).id, 'bbb222bbb222');

    const missing = await fetch(`${baseUrl}/api/dashboard/documents/missing-doc`);
    assert.equal(missing.status, 404);

    const dashboard = await fetch(`${baseUrl}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /data-detail-panel/);
    assert.equal(authChecks, 5);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
