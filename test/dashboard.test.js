'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { renderDashboard, renderDocumentDetail } = require('../src/dashboard');
const { DASHBOARD_CLIENT_SCRIPT } = require('../src/dashboardClient');

const BASE_URL = 'https://pages.example.test';

test('dashboard renders sticky tabbed explorer with infinite list and detail panel', () => {
  assert.doesNotThrow(() => new Function(DASHBOARD_CLIENT_SCRIPT));
  const html = renderDashboard({
    baseUrl: BASE_URL,
    documents: {
      cursor: 0,
      limit: 24,
      total: 3,
      nextCursor: 1,
      hasMore: true,
      query: '',
      items: [
        {
          slug: 'phase-four-doc',
          title: 'Phase Four',
          owner: 'writer',
          latestRevision: 'bbb222bbb222',
          latestRevNumber: 2,
          latestRevCreatedAt: '2026-06-15T02:00:00.000Z',
          revisionCount: 2,
          updatedAt: '2026-06-15T02:00:00.000Z',
        },
      ],
    },
    pages: {
      cursor: 0,
      limit: 24,
      total: 2,
      nextCursor: 1,
      hasMore: true,
      query: '',
      items: [
        {
          id: 'aaa111aaa111',
          title: 'Anonymous Page',
          createdAt: '2026-06-15T01:00:00.000Z',
          private: false,
        },
      ],
    },
  });

  assert.match(html, /문서/);
  assert.match(html, /단발 게시/);
  assert.match(html, /class="dashboard-controls"/);
  assert.match(html, /position: sticky/);
  assert.match(html, /type="search"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /data-tab="documents"/);
  assert.match(html, /data-tab="pages"/);
  assert.match(html, /data-item-list/);
  assert.match(html, /data-load-sentinel/);
  assert.match(html, /data-detail-panel/);
  assert.match(html, /data-detail-content/);
  assert.match(html, /cursor=/);
  assert.match(html, /nextCursor/);
  assert.doesNotMatch(html, /class="pagination"/);
  assert.match(html, /phase-four-doc/);
  assert.match(html, /Phase Four/);
  assert.match(html, /r2 · 2026-06-15T02:00:00.000Z/);
  assert.match(html, /writer/);
  assert.match(html, /Anonymous Page/);
  assert.match(html, new RegExp(`${BASE_URL}/p/aaa111aaa111`));
  assert.match(html, /data-kind="documents"/);
  assert.match(html, /data-item-id="phase-four-doc"/);
  assert.match(html, /data-kind="documents"[^>]+data-item-id=[^>]+data-action="toggle-visibility"/);
  assert.match(html, /\/api\/dashboard\/documents\/.*\/visibility/);
  assert.match(html, /resetCollectionsForSearch/);
  assert.match(html, /Promise\.allSettled/);
  assert.match(html, /prefetchNext/);
  assert.match(html, /prefetchPromise/);
  assert.match(html, /clientHeight \* 1\.5/);
});

test('document detail renders revisions, fixed HTML links, and rev-scoped comments', () => {
  const html = renderDocumentDetail({
    baseUrl: BASE_URL,
    documentRecord: {
      slug: 'phase-four-doc',
      title: 'Phase Four',
      owner: 'writer',
      latestRevision: 'bbb222bbb222',
      createdAt: '2026-06-15T01:00:00.000Z',
      updatedAt: '2026-06-15T02:00:00.000Z',
    },
    revisions: [
      {
        revId: 'bbb222bbb222',
        revNumber: 2,
        status: 'published',
        createdAt: '2026-06-15T02:00:00.000Z',
        reviewable: true,
        commentCount: 1,
        comments: [
          {
            id: 'cmt_1',
            author: 'reviewer',
            selected_text: 'selected sentence',
            comment: 'Check this sentence',
            status: 'needs_agent_review',
            created_at: '2026-06-15T02:10:00.000Z',
          },
        ],
      },
      {
        revId: 'aaa111aaa111',
        revNumber: 1,
        status: 'published',
        createdAt: '2026-06-15T01:00:00.000Z',
        reviewable: false,
        commentCount: 0,
        comments: [],
      },
    ],
  });

  assert.match(html, new RegExp(`${BASE_URL}/d/phase-four-doc`));
  assert.match(html, new RegExp(`${BASE_URL}/d/phase-four-doc/r/2`));
  assert.match(html, /HTML 보기/);
  assert.match(html, /reviewable/);
  assert.match(html, /코멘트 보기 \(1\)/);
  assert.match(html, /Check this sentence/);
  assert.match(html, /reviewer/);
  assert.match(html, /selected sentence/);
  assert.match(html, /needs_agent_review/);
  assert.match(html, /코멘트 보기 \(0\)/);
});

test('dashboard search refreshes both tab counts with one first-batch request each', async () => {
  const harness = runDashboardClient({
    documents: dashboardPage([], { total: 3 }),
    pages: dashboardPage([], { total: 4 }),
  }, (url) => {
    const kind = url.includes('/documents?') ? 'documents' : 'pages';
    return dashboardPage([], { total: kind === 'documents' ? 1 : 2, query: 'alpha' });
  });

  harness.elements.search.value = 'alpha';
  harness.elements.search.dispatch('input');
  await flushPromises();

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests.filter((url) => url.includes('/api/dashboard/documents?')).length, 1);
  assert.equal(harness.requests.filter((url) => url.includes('/api/dashboard/pages?')).length, 1);
  assert.ok(harness.requests.every((url) => url.includes('q=alpha')));
  assert.equal(harness.tabs.documents.count.textContent, '1');
  assert.equal(harness.tabs.pages.count.textContent, '2');
});

test('dashboard consumes one prefetched page without a duplicate boundary request', async () => {
  const harness = runDashboardClient({
    documents: dashboardPage([{ slug: 'first', title: 'First' }], {
      total: 2,
      limit: 1,
      nextCursor: 1,
      hasMore: true,
    }),
    pages: dashboardPage([], { total: 0 }),
  }, () => dashboardPage([{ slug: 'second', title: 'Second' }], {
    total: 2,
    cursor: 1,
    limit: 1,
  }));

  await flushPromises();
  assert.equal(harness.requests.length, 1);
  assert.ok(harness.requests[0].includes('cursor=1'));

  harness.elements.viewport.scrollTop = 1;
  harness.elements.viewport.dispatch('scroll');
  await flushPromises();

  assert.equal(harness.requests.length, 1);
  assert.match(harness.elements.items.innerHTML, /Second/);
});

function dashboardPage(items, overrides = {}) {
  return {
    items,
    total: items.length,
    cursor: 0,
    limit: 24,
    nextCursor: null,
    hasMore: false,
    query: '',
    ...overrides,
  };
}

function runDashboardClient(seedCollections, responseFor) {
  class FakeElement {
    constructor() {
      this.listeners = {};
      this.dataset = {};
      this.classList = { add() {}, remove() {} };
      this.innerHTML = '';
      this.textContent = '';
      this.value = '';
      this.hidden = false;
      this.scrollHeight = 1000;
      this.scrollTop = 0;
      this.clientHeight = 400;
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    dispatch(type) { return this.listeners[type]?.({ target: this }); }
    setAttribute(name, value) { this[name] = value; }
    querySelector() { return null; }
    focus() {}
  }

  const elements = {
    workspace: new FakeElement(),
    viewport: new FakeElement(),
    items: new FakeElement(),
    sentinel: new FakeElement(),
    count: new FakeElement(),
    loadState: new FakeElement(),
    search: new FakeElement(),
    clear: new FakeElement(),
    detail: new FakeElement(),
    detailContent: new FakeElement(),
  };
  const tabs = {};
  for (const kind of ['documents', 'pages']) {
    const tab = new FakeElement();
    tab.dataset.tab = kind;
    tab.count = new FakeElement();
    tab.querySelector = () => tab.count;
    tabs[kind] = tab;
  }
  const selectorMap = new Map([
    ['[data-dashboard-workspace]', elements.workspace],
    ['[data-item-list]', elements.viewport],
    ['[data-list-items]', elements.items],
    ['[data-load-sentinel]', elements.sentinel],
    ['[data-result-count]', elements.count],
    ['[data-load-state]', elements.loadState],
    ['[data-search-input]', elements.search],
    ['[data-search-clear]', elements.clear],
    ['[data-detail-panel]', elements.detail],
    ['[data-detail-content]', elements.detailContent],
  ]);
  const requests = [];
  const seed = { baseUrl: BASE_URL, ...seedCollections };
  const document = {
    querySelector: (selector) => selectorMap.get(selector),
    querySelectorAll: () => Object.values(tabs),
    getElementById: () => ({ textContent: JSON.stringify(seed) }),
    addEventListener() {},
  };
  const context = {
    document,
    window: { location: { origin: BASE_URL } },
    URL,
    Intl,
    console,
    alert() {},
    confirm: () => true,
    clearTimeout() {},
    setTimeout: (callback) => { callback(); return 1; },
    requestAnimationFrame() {},
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => responseFor(url) };
    },
  };
  vm.runInNewContext(DASHBOARD_CLIENT_SCRIPT, context);
  return { elements, tabs, requests };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
