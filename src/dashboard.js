'use strict';

const DEFAULT_DASHBOARD_PAGE_SIZE = 25;
const DASHBOARD_ROW_HEIGHT = 96;

function renderDashboard({ pages, documents = [], baseUrl }) {
  const documentPage = normalizeCollection(documents, DEFAULT_DASHBOARD_PAGE_SIZE);
  const pagePage = normalizeCollection(pages, DEFAULT_DASHBOARD_PAGE_SIZE);
  const documentRows = documentPage.items.map((documentRecord) => renderDocumentRow(documentRecord)).join('');
  const pageRows = pagePage.items.map((page) => renderPageRow(page, baseUrl)).join('');

  return renderLayout({
    title: 'Pages 대시보드',
    body: `
  <main class="page-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Pages</p>
        <h1>대시보드</h1>
        <p class="lede">문서와 단발 게시를 분리해 관리합니다.</p>
      </div>
      <a class="button secondary" href="/auth/logout">로그아웃</a>
    </header>

    <section class="summary-grid" aria-label="요약">
      <article class="summary-item">
        <span>문서</span>
        <strong>${escHtml(documentPage.total)}</strong>
      </article>
      <article class="summary-item">
        <span>단발 게시</span>
        <strong>${escHtml(pagePage.total)}</strong>
      </article>
    </section>

    ${renderDashboardSection({
      kind: 'documents',
      title: '문서',
      subtitle: '고정 URL과 리비전을 가진 장기 문서',
      page: documentPage,
      rows: documentRows,
      emptyLabel: '문서가 없습니다',
    })}

    ${renderDashboardSection({
      kind: 'pages',
      title: '단발 게시',
      subtitle: '일회성 HTML 공유 페이지',
      page: pagePage,
      rows: pageRows,
      emptyLabel: '단발 게시가 없습니다',
    })}
  </main>
  ${jsonScript('dashboard-documents-data', documentPage)}
  ${jsonScript('dashboard-pages-data', pagePage)}
  ${dashboardScript(baseUrl)}`,
  });
}

function renderDashboardSection({ kind, title, subtitle, page, rows, emptyLabel }) {
  const hasItems = page.items.length > 0;
  return `
    <section class="dashboard-section" data-section="${escAttr(kind)}" data-endpoint="/api/dashboard/${kind === 'documents' ? 'documents' : 'pages'}">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${escHtml(title)}</p>
          <h2>${escHtml(title)}</h2>
          <p>${escHtml(subtitle)}</p>
        </div>
        ${renderPagination(page)}
      </div>
      <div class="virtual-list" data-virtual-list="${escAttr(kind)}" data-row-height="${DASHBOARD_ROW_HEIGHT}" tabindex="0" aria-label="${escAttr(title)} 목록">
        <div class="virtual-spacer" style="height:${hasItems ? page.items.length * DASHBOARD_ROW_HEIGHT : 0}px"></div>
        <div class="virtual-items">${hasItems ? rows : emptyState(emptyLabel)}</div>
      </div>
    </section>`;
}

function renderPagination(page) {
  const pageLabel = page.totalPages ? `${page.page} / ${page.totalPages}` : '0 / 0';
  const prevDisabled = page.page <= 1 ? ' disabled' : '';
  const nextDisabled = !page.totalPages || page.page >= page.totalPages ? ' disabled' : '';
  return `
        <nav class="pagination" aria-label="페이지 이동">
          <button class="button secondary" type="button" data-page-action="prev"${prevDisabled}>이전</button>
          <span class="page-label" data-page-label>${escHtml(pageLabel)}</span>
          <button class="button secondary" type="button" data-page-action="next"${nextDisabled}>다음</button>
        </nav>`;
}

function renderDocumentDetail({ documentRecord, revisions, baseUrl }) {
  const stableUrl = `${baseUrl}/d/${documentRecord.slug}`;
  const revisionRows = revisions.map((revision) => renderRevisionRow(documentRecord, revision, baseUrl)).join('');
  return renderLayout({
    title: `${documentRecord.slug} - Pages 문서`,
    body: `
  <main class="page-shell">
    <header class="topbar">
      <div>
        <p><a class="back-link" href="/dashboard">대시보드로 돌아가기</a></p>
        <h1>${escHtml(documentRecord.title)}</h1>
        <p class="lede"><code>${escHtml(documentRecord.slug)}</code> | owner ${escHtml(documentRecord.owner)}</p>
      </div>
      <a class="button secondary" href="/auth/logout">로그아웃</a>
    </header>

    <section class="dashboard-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">문서 메타</p>
          <h2>문서 메타</h2>
        </div>
      </div>
      <dl class="meta">
        <div><dt>Stable URL</dt><dd><a href="${escAttr(stableUrl)}" target="_blank" rel="noreferrer">${escHtml(stableUrl)}</a></dd></div>
        <div><dt>Latest revision</dt><dd>${escHtml(documentRecord.latestRevision)}</dd></div>
        <div><dt>Created</dt><dd>${escHtml(formatDate(documentRecord.createdAt))}</dd></div>
        <div><dt>Updated</dt><dd>${escHtml(formatDate(documentRecord.updatedAt))}</dd></div>
      </dl>
    </section>

    <section class="dashboard-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Revisions</p>
          <h2>Revisions</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Rev</th><th>Status</th><th>Created</th><th>Comments</th><th>Review</th><th>Links</th></tr>
          </thead>
          <tbody>${revisionRows || emptyRow(6, '리비전이 없습니다')}</tbody>
        </table>
      </div>
    </section>
  </main>`,
  });
}

function renderDocumentRow(documentRecord) {
  const detailUrl = `/dashboard/documents/${encodeURIComponent(documentRecord.slug)}`;
  const latestLabel = documentRecord.latestRevNumber
    ? `r${documentRecord.latestRevNumber} · ${formatDate(documentRecord.latestRevCreatedAt)}`
    : '-';
  const revisionLabel = `${documentRecord.revisionCount || 0} revisions`;
  return `
        <article class="list-row document-row" data-item-id="${escAttr(documentRecord.slug)}">
          <div class="row-main">
            <a class="row-title" href="${escAttr(detailUrl)}"><code>${escHtml(documentRecord.slug)}</code></a>
            <span class="row-subtitle">${escHtml(documentRecord.title)}</span>
          </div>
          <div class="row-meta">
            <span>${escHtml(latestLabel)}</span>
            <span>${escHtml(revisionLabel)}</span>
            <span>${escHtml(documentRecord.owner)}</span>
            <span>${escHtml(formatDate(documentRecord.updatedAt))}</span>
          </div>
        </article>`;
}

function renderPageRow(page, baseUrl) {
  const url = `${baseUrl}/p/${page.id}`;
  const visLabel = page.private ? '비공개' : '공개';
  const toggleLabel = page.private ? '공개로 전환' : '비공개로 전환';
  const toggleValue = page.private ? 'false' : 'true';
  return `
        <article class="list-row page-row" data-item-id="${escAttr(page.id)}">
          <div class="row-main">
            <a class="row-title" href="${escAttr(url)}" target="_blank" rel="noreferrer">${escHtml(page.title)}</a>
            <span class="row-subtitle">${escHtml(page.id)} | ${escHtml(formatDate(page.createdAt))}</span>
          </div>
          <div class="row-actions">
            <span class="status-pill">${escHtml(visLabel)}</span>
            <button class="button secondary" type="button" data-action="toggle-visibility" data-page-id="${escAttr(page.id)}" data-private="${escAttr(toggleValue)}">${escHtml(toggleLabel)}</button>
            <button class="button danger" type="button" data-action="delete-page" data-page-id="${escAttr(page.id)}">삭제</button>
          </div>
        </article>`;
}

function renderRevisionRow(documentRecord, revision, baseUrl) {
  const revisionUrl = `${baseUrl}/d/${documentRecord.slug}/r/${revision.revNumber}`;
  const comments = revision.comments || [];
  const commentList = comments.map(renderComment).join('');
  const reviewLabel = revision.reviewable ? 'reviewable' : '-';
  return `
        <tr>
          <td>r${escHtml(revision.revNumber)}</td>
          <td>${escHtml(revision.status)}</td>
          <td>${escHtml(formatDate(revision.createdAt))}</td>
          <td>${escHtml(revision.commentCount)}</td>
          <td>${reviewLabel}</td>
          <td><a class="button secondary" href="${escAttr(revisionUrl)}" target="_blank" rel="noreferrer">HTML 보기</a></td>
        </tr>
        <tr class="comment-row">
          <td colspan="6">
            <details>
              <summary>코멘트 보기 (${escHtml(revision.commentCount)})</summary>
              ${commentList || '<p class="muted">코멘트가 없습니다</p>'}
            </details>
          </td>
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

function renderLayout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f5f7;
      --surface: rgba(255, 255, 255, 0.92);
      --surface-strong: #fff;
      --text: #1d1d1f;
      --muted: #6e6e73;
      --line: rgba(0, 0, 0, 0.12);
      --blue: #0071e3;
      --red: #d70015;
      --row-height: ${DASHBOARD_ROW_HEIGHT}px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 40px; line-height: 1.08; font-weight: 700; }
    h2 { font-size: 22px; line-height: 1.18; font-weight: 700; }
    code {
      background: rgba(0, 0, 0, 0.06);
      border-radius: 6px;
      padding: 2px 6px;
      font-family: "SF Mono", Consolas, monospace;
      font-size: 0.92em;
    }
    .page-shell {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 40px 0 56px;
    }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 24px;
    }
    .eyebrow {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .lede {
      color: var(--muted);
      font-size: 15px;
      line-height: 1.45;
      margin-top: 8px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .summary-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 72px;
      padding: 16px 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }
    .summary-item span { color: var(--muted); font-size: 14px; font-weight: 600; }
    .summary-item strong { font-size: 30px; line-height: 1; }
    .dashboard-section {
      margin-top: 16px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }
    .section-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .section-heading p:not(.eyebrow) {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
      margin-top: 6px;
    }
    .pagination, .row-actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: nowrap;
      white-space: nowrap;
    }
    .page-label {
      min-width: 58px;
      color: var(--muted);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
      text-align: center;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      max-width: 100%;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: var(--blue);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      line-height: 1;
      text-decoration: none;
      white-space: nowrap;
    }
    .button:hover { text-decoration: none; }
    .button:disabled {
      cursor: default;
      opacity: 0.45;
    }
    .button.secondary {
      border-color: var(--line);
      background: var(--surface-strong);
      color: var(--text);
    }
    .button.danger {
      border-color: rgba(215, 0, 21, 0.22);
      background: rgba(215, 0, 21, 0.08);
      color: var(--red);
    }
    .virtual-list {
      position: relative;
      height: min(52vh, 520px);
      min-height: 220px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-strong);
      contain: strict;
    }
    .virtual-spacer { width: 1px; opacity: 0; }
    .virtual-items {
      position: absolute;
      top: 0;
      right: 0;
      left: 0;
      will-change: transform;
    }
    .list-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 16px;
      height: var(--row-height);
      padding: 14px 16px;
      border-bottom: 1px solid rgba(0, 0, 0, 0.08);
      overflow: hidden;
    }
    .list-row:last-child { border-bottom: 0; }
    .row-main {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .row-title {
      display: block;
      min-width: 0;
      overflow: hidden;
      color: var(--text);
      font-size: 15px;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-subtitle {
      min-width: 0;
      overflow: hidden;
      color: var(--muted);
      font-size: 13px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-meta {
      display: grid;
      grid-template-columns: repeat(4, max-content);
      gap: 10px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.06);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .empty-state {
      display: grid;
      min-height: 180px;
      place-items: center;
      color: var(--muted);
      font-size: 14px;
    }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-strong);
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(0, 0, 0, 0.08);
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      background: rgba(0, 0, 0, 0.03);
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    .danger { color: var(--red); }
    .muted { color: var(--muted); }
    .comment-row td {
      background: rgba(0, 0, 0, 0.025);
      white-space: normal;
    }
    .comment {
      margin: 10px 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .comment p { margin: 0 0 8px; }
    .meta, .comment-meta {
      display: grid;
      grid-template-columns: minmax(120px, max-content) 1fr;
      gap: 8px 12px;
      padding: 0;
    }
    .meta div, .comment-meta div { display: contents; }
    dt { color: var(--muted); font-weight: 700; }
    dd { margin: 0; min-width: 0; }
    .back-link { font-size: 14px; font-weight: 600; }
    @media (max-width: 760px) {
      :root { --row-height: 112px; }
      .page-shell { width: min(100vw - 20px, 1180px); padding-top: 24px; }
      h1 { font-size: 32px; }
      .topbar, .section-heading { align-items: stretch; flex-direction: column; }
      .summary-grid { grid-template-columns: 1fr; }
      .pagination { justify-content: space-between; }
      .list-row { grid-template-columns: minmax(0, 1fr); align-items: start; }
      .row-meta { grid-template-columns: repeat(2, max-content); }
      .row-actions { justify-content: flex-start; overflow-x: auto; }
      .virtual-list { height: min(58vh, 480px); }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function dashboardScript(baseUrl) {
  return `<script>
    (function () {
      const state = {
        documents: {
          endpoint: '/api/dashboard/documents',
          page: readJson('dashboard-documents-data'),
          render: renderDocumentItem,
          emptyLabel: '문서가 없습니다',
        },
        pages: {
          endpoint: '/api/dashboard/pages',
          page: readJson('dashboard-pages-data'),
          render: renderPageItem,
          emptyLabel: '단발 게시가 없습니다',
        },
      };

      for (const key of Object.keys(state)) setupSection(key, state[key]);
      document.addEventListener('click', handlePageAction);

      function setupSection(key, config) {
        const section = document.querySelector('[data-section="' + key + '"]');
        if (!section) return;
        config.section = section;
        config.viewport = section.querySelector('[data-virtual-list]');
        config.spacer = section.querySelector('.virtual-spacer');
        config.items = section.querySelector('.virtual-items');
        config.pageLabel = section.querySelector('[data-page-label]');
        config.prev = section.querySelector('[data-page-action="prev"]');
        config.next = section.querySelector('[data-page-action="next"]');
        config.rowHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-height')) || Number(config.viewport.dataset.rowHeight || ${DASHBOARD_ROW_HEIGHT});
        config.viewport.addEventListener('scroll', function () { renderVirtualList(config); }, { passive: true });
        config.prev.addEventListener('click', function () { loadPage(config, config.page.page - 1); });
        config.next.addEventListener('click', function () { loadPage(config, config.page.page + 1); });
        renderVirtualList(config);
      }

      async function loadPage(config, page) {
        if (!page || page < 1 || page > config.page.totalPages) return;
        const url = config.endpoint + '?page=' + encodeURIComponent(page) + '&pageSize=' + encodeURIComponent(config.page.pageSize);
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          alert('페이지를 불러오지 못했습니다: ' + res.status);
          return;
        }
        config.page = await res.json();
        config.viewport.scrollTop = 0;
        renderVirtualList(config);
      }

      async function handlePageAction(event) {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const id = button.dataset.pageId;
        if (!id) return;
        if (button.dataset.action === 'toggle-visibility') {
          const res = await fetch('/api/pages/' + id + '/visibility', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ private: button.dataset.private === 'true' }),
          });
          if (res.ok) location.reload();
          else alert('전환 실패: ' + res.status);
        }
        if (button.dataset.action === 'delete-page') {
          if (!confirm('정말 삭제하시겠습니까?')) return;
          const res = await fetch('/api/pages/' + id, { method: 'DELETE' });
          if (res.ok) location.reload();
          else alert('삭제 실패: ' + res.status);
        }
      }

      function renderVirtualList(config) {
        const items = config.page.items || [];
        if (!items.length) {
          config.spacer.style.height = '0px';
          config.items.style.transform = 'translateY(0)';
          config.items.innerHTML = '<div class="empty-state">' + escapeHtml(config.emptyLabel) + '</div>';
          updatePagination(config);
          return;
        }
        const rowHeight = config.rowHeight;
        const viewportHeight = config.viewport.clientHeight || 360;
        const start = Math.max(0, Math.floor(config.viewport.scrollTop / rowHeight) - 3);
        const visibleCount = Math.ceil(viewportHeight / rowHeight) + 6;
        const end = Math.min(items.length, start + visibleCount);
        config.spacer.style.height = String(items.length * rowHeight) + 'px';
        config.items.style.transform = 'translateY(' + String(start * rowHeight) + 'px)';
        config.items.innerHTML = items.slice(start, end).map(config.render).join('');
        updatePagination(config);
      }

      function updatePagination(config) {
        const page = config.page;
        config.pageLabel.textContent = page.totalPages ? page.page + ' / ' + page.totalPages : '0 / 0';
        config.prev.disabled = page.page <= 1;
        config.next.disabled = !page.totalPages || page.page >= page.totalPages;
      }

      function renderDocumentItem(item) {
        const detailUrl = '/dashboard/documents/' + encodeURIComponent(item.slug || '');
        const latestLabel = item.latestRevNumber ? 'r' + item.latestRevNumber + ' · ' + formatDate(item.latestRevCreatedAt) : '-';
        return '<article class="list-row document-row" data-item-id="' + escapeAttr(item.slug) + '">' +
          '<div class="row-main">' +
            '<a class="row-title" href="' + escapeAttr(detailUrl) + '"><code>' + escapeHtml(item.slug) + '</code></a>' +
            '<span class="row-subtitle">' + escapeHtml(item.title) + '</span>' +
          '</div>' +
          '<div class="row-meta">' +
            '<span>' + escapeHtml(latestLabel) + '</span>' +
            '<span>' + escapeHtml(String(item.revisionCount || 0) + ' revisions') + '</span>' +
            '<span>' + escapeHtml(item.owner) + '</span>' +
            '<span>' + escapeHtml(formatDate(item.updatedAt)) + '</span>' +
          '</div>' +
        '</article>';
      }

      function renderPageItem(item) {
        const url = '${escJsTemplate(baseUrl)}/p/' + encodeURIComponent(item.id || '');
        const isPrivate = item.private === true;
        return '<article class="list-row page-row" data-item-id="' + escapeAttr(item.id) + '">' +
          '<div class="row-main">' +
            '<a class="row-title" href="' + escapeAttr(url) + '" target="_blank" rel="noreferrer">' + escapeHtml(item.title) + '</a>' +
            '<span class="row-subtitle">' + escapeHtml(item.id) + ' | ' + escapeHtml(formatDate(item.createdAt)) + '</span>' +
          '</div>' +
          '<div class="row-actions">' +
            '<span class="status-pill">' + (isPrivate ? '비공개' : '공개') + '</span>' +
            '<button class="button secondary" type="button" data-action="toggle-visibility" data-page-id="' + escapeAttr(item.id) + '" data-private="' + (isPrivate ? 'false' : 'true') + '">' + (isPrivate ? '공개로 전환' : '비공개로 전환') + '</button>' +
            '<button class="button danger" type="button" data-action="delete-page" data-page-id="' + escapeAttr(item.id) + '">삭제</button>' +
          '</div>' +
        '</article>';
      }

      function readJson(id) {
        const el = document.getElementById(id);
        if (!el) return { items: [], page: 0, pageSize: ${DEFAULT_DASHBOARD_PAGE_SIZE}, total: 0, totalPages: 0 };
        return JSON.parse(el.textContent);
      }
      function formatDate(value) { return value || '-'; }
      function escapeHtml(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }
      function escapeAttr(value) {
        return escapeHtml(value).replace(/'/g, '&#39;');
      }
    })();
  </script>`;
}

function emptyRow(colspan, label) {
  return `<tr><td colspan="${colspan}" style="text-align:center">${escHtml(label)}</td></tr>`;
}

function emptyState(label) {
  return `<div class="empty-state">${escHtml(label)}</div>`;
}

function normalizeCollection(value, fallbackPageSize) {
  if (Array.isArray(value)) {
    const total = value.length;
    return {
      items: value,
      page: total ? 1 : 0,
      pageSize: total || fallbackPageSize,
      total,
      totalPages: total ? 1 : 0,
    };
  }
  const items = Array.isArray(value?.items) ? value.items : [];
  const pageSize = positiveInteger(value?.pageSize) || fallbackPageSize;
  const total = Math.max(0, Number(value?.total || items.length || 0));
  const totalPages = total ? Math.max(1, Math.ceil(total / pageSize)) : 0;
  const page = totalPages ? Math.min(Math.max(positiveInteger(value?.page) || 1, 1), totalPages) : 0;
  return { items, page, pageSize, total, totalPages };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function jsonScript(id, value) {
  const json = JSON.stringify(value).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${escAttr(id)}">${json}</script>`;
}

function escJsTemplate(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatDate(value) {
  return value || '-';
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value) {
  return escHtml(value).replace(/'/g, '&#39;');
}

module.exports = {
  renderDashboard,
  renderDocumentDetail,
};
