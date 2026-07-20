'use strict';

const { DASHBOARD_CLIENT_SCRIPT } = require('./dashboardClient');
const { DASHBOARD_STYLES } = require('./dashboardStyles');

const DEFAULT_DASHBOARD_LIMIT = 24;

function renderDashboard({ pages, documents = [], baseUrl }) {
  const documentBatch = normalizeBatch(documents);
  const pageBatch = normalizeBatch(pages);
  const documentRows = documentBatch.items.map(renderDocumentItem).join('');
  const initialState = { baseUrl, documents: documentBatch, pages: pageBatch };
  return renderLayout({
    title: 'Pages 대시보드',
    bodyClass: 'dashboard-page',
    body: `
  <main class="dashboard-shell">
    <header class="dashboard-controls">
      <div class="dashboard-topbar">
        <div>
          <p class="brand-line">Pages</p>
          <h1>대시보드</h1>
          <p class="lede">문서와 단발 게시를 빠르게 찾고, 한 화면에서 상세를 확인합니다.</p>
        </div>
        <a class="button secondary" href="/auth/logout">로그아웃</a>
      </div>
      <div class="toolbar">
        <label class="search-wrap">
          <span hidden>검색</span>
          <input class="search-input" type="search" data-search-input autocomplete="off" placeholder="문서 제목 또는 slug 검색">
          <button class="search-clear" type="button" data-search-clear aria-label="검색어 지우기" hidden>×</button>
        </label>
        <div class="tabs" role="tablist" aria-label="게시 유형">
          <button class="tab" type="button" role="tab" data-tab="documents" aria-selected="true">
            문서 <span class="tab-count" data-tab-count>${escHtml(documentBatch.total)}</span>
          </button>
          <button class="tab" type="button" role="tab" data-tab="pages" aria-selected="false" tabindex="-1">
            단발 게시 <span class="tab-count" data-tab-count>${escHtml(pageBatch.total)}</span>
          </button>
        </div>
      </div>
    </header>

    <section class="dashboard-workspace" data-dashboard-workspace>
      <section class="list-panel" aria-label="게시 목록">
        <div class="list-toolbar">
          <span class="result-count" data-result-count>${escHtml(documentBatch.total)}개</span>
          <span class="load-state" data-load-state aria-live="polite"></span>
        </div>
        <div class="item-list" data-item-list tabindex="0">
          <div data-list-items>${documentRows || emptyState('아직 문서가 없습니다.')}</div>
          <div class="load-sentinel" data-load-sentinel>${documentBatch.hasMore ? '아래로 스크롤해 더 보기' : (documentRows ? '목록의 끝입니다' : '')}</div>
        </div>
      </section>
      <aside class="detail-panel" data-detail-panel aria-hidden="true" aria-label="상세 정보">
        <div data-detail-content>
          <div class="detail-placeholder">항목을 선택하면 상세 정보가 표시됩니다.</div>
        </div>
      </aside>
    </section>
  </main>
  <noscript>${pageBatch.items.map((page) => `<a href="${escAttr(`${baseUrl}/p/${page.id}/`)}">${escHtml(page.title)}</a>`).join('')}</noscript>
  ${jsonScript('dashboard-initial-state', initialState)}
  <script>${DASHBOARD_CLIENT_SCRIPT}</script>`,
  });
}

function renderDocumentItem(documentRecord) {
  const slug = documentRecord.slug || '';
  const latest = documentRecord.latestRevNumber ? `r${documentRecord.latestRevNumber}` : '리비전 없음';
  const statusClass = documentRecord.private ? ' private' : '';
  return `
          <article class="list-item" data-kind="documents" data-item-id="${escAttr(slug)}">
            <button class="item-select" type="button" data-select-item data-kind="documents" data-item-id="${escAttr(slug)}">
              <span class="item-title">${escHtml(documentRecord.title || slug)}</span>
              <span class="item-subtitle">${escHtml(`${slug} · ${latest} · ${formatDate(documentRecord.updatedAt)}`)}</span>
            </button>
            <div class="item-actions">
              <span class="status-pill${statusClass}">${documentRecord.private ? '비공개' : '공개'}</span>
              <span class="status-pill">${escHtml(documentRecord.revisionCount || 0)} revisions</span>
            </div>
          </article>`;
}

function renderDocumentDetail({ documentRecord, revisions, baseUrl }) {
  const stableUrl = `${baseUrl}/d/${documentRecord.slug}/`;
  const revisionRows = revisions.map((revision) => renderRevisionRow(documentRecord, revision, baseUrl)).join('');
  return renderLayout({
    title: `${documentRecord.slug} - Pages 문서`,
    body: `
  <main class="page-shell">
    <header class="topbar">
      <div>
        <p><a href="/dashboard">대시보드로 돌아가기</a></p>
        <h1>${escHtml(documentRecord.title)}</h1>
        <p class="lede"><code>${escHtml(documentRecord.slug)}</code> · owner ${escHtml(documentRecord.owner)}</p>
      </div>
      <a class="button secondary" href="/auth/logout">로그아웃</a>
    </header>
    <section class="dashboard-section">
      <div class="section-heading"><div><p class="eyebrow">문서 메타</p><h2>문서 메타</h2></div></div>
      <dl class="meta">
        <div><dt>Stable URL</dt><dd><a href="${escAttr(stableUrl)}" target="_blank" rel="noreferrer">${escHtml(stableUrl)}</a></dd></div>
        <div><dt>Latest revision</dt><dd>${escHtml(documentRecord.latestRevision)}</dd></div>
        <div><dt>Created</dt><dd>${escHtml(formatDate(documentRecord.createdAt))}</dd></div>
        <div><dt>Updated</dt><dd>${escHtml(formatDate(documentRecord.updatedAt))}</dd></div>
      </dl>
    </section>
    <section class="dashboard-section">
      <div class="section-heading"><div><p class="eyebrow">Revisions</p><h2>Revisions</h2></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Rev</th><th>Status</th><th>Created</th><th>Comments</th><th>Review</th><th>Links</th></tr></thead>
          <tbody>${revisionRows || emptyRow(6, '리비전이 없습니다')}</tbody>
        </table>
      </div>
    </section>
  </main>`,
  });
}

function renderRevisionRow(documentRecord, revision, baseUrl) {
  const revisionUrl = `${baseUrl}/d/${documentRecord.slug}/r/${revision.revNumber}/`;
  const comments = revision.comments || [];
  const commentList = comments.map(renderComment).join('');
  return `
        <tr>
          <td>r${escHtml(revision.revNumber)}</td>
          <td>${escHtml(revision.status)}</td>
          <td>${escHtml(formatDate(revision.createdAt))}</td>
          <td>${escHtml(revision.commentCount || 0)}</td>
          <td>${revision.reviewable ? 'reviewable' : '-'}</td>
          <td><a class="button secondary" href="${escAttr(revisionUrl)}" target="_blank" rel="noreferrer">HTML 보기</a></td>
        </tr>
        <tr class="comment-row">
          <td colspan="6"><details><summary>코멘트 보기 (${escHtml(revision.commentCount || 0)})</summary>
            ${commentList || '<p class="muted">코멘트가 없습니다</p>'}
          </details></td>
        </tr>`;
}

function renderComment(comment) {
  const author = comment.author || 'reviewer';
  const body = comment.comment || comment.body || '';
  const selectedText = comment.selected_text || comment.anchor?.selected_text || '';
  const status = comment.resolved === true || comment.status === 'resolved' ? 'resolved' : (comment.status || 'open');
  return `
            <article class="comment">
              <p>${escHtml(body)}</p>
              <dl class="comment-meta">
                <div><dt>Author</dt><dd>${escHtml(author)}</dd></div>
                <div><dt>Anchor</dt><dd>${escHtml(selectedText || '-')}</dd></div>
                <div><dt>Created</dt><dd>${escHtml(formatDate(comment.created_at))}</dd></div>
                <div><dt>Status</dt><dd>${escHtml(status)}</dd></div>
              </dl>
            </article>`;
}

function renderLayout({ title, body, bodyClass = '' }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <style>${DASHBOARD_STYLES}</style>
</head>
<body class="${escAttr(bodyClass)}">${body}</body>
</html>`;
}

function normalizeBatch(value) {
  if (Array.isArray(value)) {
    return {
      items: value,
      total: value.length,
      cursor: 0,
      limit: value.length || DEFAULT_DASHBOARD_LIMIT,
      nextCursor: null,
      hasMore: false,
      query: '',
    };
  }
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    items,
    total: Math.max(0, Number(value?.total || 0)),
    cursor: Math.max(0, Number(value?.cursor || 0)),
    limit: Math.max(1, Number(value?.limit || DEFAULT_DASHBOARD_LIMIT)),
    nextCursor: value?.nextCursor == null ? null : Number(value.nextCursor),
    hasMore: value?.hasMore === true,
    query: typeof value?.query === 'string' ? value.query : '',
  };
}

function jsonScript(id, value) {
  const json = JSON.stringify(value).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${escAttr(id)}">${json}</script>`;
}

function emptyRow(colspan, label) {
  return `<tr><td colspan="${colspan}" style="text-align:center">${escHtml(label)}</td></tr>`;
}

function emptyState(label) {
  return `<div class="empty-state">${escHtml(label)}</div>`;
}

function formatDate(value) { return value || '-'; }

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value) { return escHtml(value).replace(/'/g, '&#39;'); }

module.exports = {
  renderDashboard,
  renderDocumentDetail,
};
