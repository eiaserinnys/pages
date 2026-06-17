'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { renderDashboard, renderDocumentDetail } = require('../src/dashboard');

const BASE_URL = 'https://pages.example.test';

test('dashboard renders document and one-off page sections with virtualized pagination shells', () => {
  const html = renderDashboard({
    baseUrl: BASE_URL,
    documents: {
      page: 2,
      pageSize: 1,
      total: 3,
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
      page: 1,
      pageSize: 1,
      total: 2,
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
  assert.match(html, /data-section="documents"/);
  assert.match(html, /data-section="pages"/);
  assert.match(html, /data-endpoint="\/api\/dashboard\/documents"/);
  assert.match(html, /data-endpoint="\/api\/dashboard\/pages"/);
  assert.match(html, /class="virtual-list"/);
  assert.match(html, /2 \/ 3/);
  assert.match(html, /1 \/ 2/);
  assert.match(html, /phase-four-doc/);
  assert.match(html, /Phase Four/);
  assert.match(html, /r2 · 2026-06-15T02:00:00.000Z/);
  assert.match(html, /writer/);
  assert.match(html, /Anonymous Page/);
  assert.match(html, new RegExp(`${BASE_URL}/p/aaa111aaa111`));
  assert.match(html, /\/dashboard\/documents\/phase-four-doc/);
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
