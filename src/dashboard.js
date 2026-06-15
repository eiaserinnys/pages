'use strict';

function renderDashboard({ pages, documents = [], baseUrl }) {
  const documentRows = documents.map((documentRecord) => renderDocumentRow(documentRecord)).join('');
  const pageRows = pages.map((page) => renderPageRow(page, baseUrl)).join('');
  return renderLayout({
    title: 'Pages 대시보드',
    body: `
  <header class="topbar">
    <div>
      <h1>Pages 대시보드</h1>
      <p>문서 ${documents.length}개 | 익명 페이지 ${pages.length}개</p>
    </div>
    <a href="/auth/logout">로그아웃</a>
  </header>

  <section>
    <h2>Documents</h2>
    <table>
      <thead>
        <tr><th>Slug</th><th>제목</th><th>Latest</th><th>Revisions</th><th>Owner</th><th>Updated</th></tr>
      </thead>
      <tbody>${documentRows || emptyRow(6, '문서가 없습니다')}</tbody>
    </table>
  </section>

  <section>
    <h2>익명 페이지</h2>
    <table>
      <thead>
        <tr><th>제목</th><th>공개 여부</th><th>생성일</th><th>관리</th></tr>
      </thead>
      <tbody>${pageRows || emptyRow(4, '페이지가 없습니다')}</tbody>
    </table>
  </section>
  ${managementScript()}`,
  });
}

function renderDocumentDetail({ documentRecord, revisions, baseUrl }) {
  const stableUrl = `${baseUrl}/d/${documentRecord.slug}`;
  const revisionRows = revisions.map((revision) => renderRevisionRow(documentRecord, revision, baseUrl)).join('');
  return renderLayout({
    title: `${documentRecord.slug} - Pages 문서`,
    body: `
  <header class="topbar">
    <div>
      <p><a href="/dashboard">대시보드로 돌아가기</a></p>
      <h1>${escHtml(documentRecord.title)}</h1>
      <p><code>${escHtml(documentRecord.slug)}</code> | owner ${escHtml(documentRecord.owner)}</p>
    </div>
    <a href="/auth/logout">로그아웃</a>
  </header>

  <section>
    <h2>문서 메타</h2>
    <dl class="meta">
      <div><dt>Stable URL</dt><dd><a href="${escAttr(stableUrl)}" target="_blank">${escHtml(stableUrl)}</a></dd></div>
      <div><dt>Latest revision</dt><dd>${escHtml(documentRecord.latestRevision)}</dd></div>
      <div><dt>Created</dt><dd>${escHtml(formatDate(documentRecord.createdAt))}</dd></div>
      <div><dt>Updated</dt><dd>${escHtml(formatDate(documentRecord.updatedAt))}</dd></div>
    </dl>
  </section>

  <section>
    <h2>Revisions</h2>
    <table>
      <thead>
        <tr><th>Rev</th><th>Status</th><th>Created</th><th>Comments</th><th>Review</th><th>Links</th></tr>
      </thead>
      <tbody>${revisionRows || emptyRow(6, '리비전이 없습니다')}</tbody>
    </table>
  </section>`,
  });
}

function renderDocumentRow(documentRecord) {
  const detailUrl = `/dashboard/documents/${encodeURIComponent(documentRecord.slug)}`;
  const latestLabel = documentRecord.latestRevNumber
    ? `r${documentRecord.latestRevNumber} · ${formatDate(documentRecord.latestRevCreatedAt)}`
    : '-';
  return `
        <tr>
          <td><a href="${escAttr(detailUrl)}"><code>${escHtml(documentRecord.slug)}</code></a></td>
          <td>${escHtml(documentRecord.title)}</td>
          <td>${escHtml(latestLabel)}</td>
          <td>${escHtml(documentRecord.revisionCount)}</td>
          <td>${escHtml(documentRecord.owner)}</td>
          <td>${escHtml(formatDate(documentRecord.updatedAt))}</td>
        </tr>`;
}

function renderPageRow(page, baseUrl) {
  const url = `${baseUrl}/p/${page.id}`;
  const visLabel = page.private ? '비공개' : '공개';
  const toggleLabel = page.private ? '공개로 전환' : '비공개로 전환';
  const toggleValue = page.private ? 'false' : 'true';
  return `
        <tr>
          <td><a href="${escAttr(url)}" target="_blank">${escHtml(page.title)}</a></td>
          <td>${visLabel}</td>
          <td>${escHtml(formatDate(page.createdAt))}</td>
          <td>
            <button onclick="toggleVisibility('${escJsString(page.id)}', ${toggleValue})">${toggleLabel}</button>
            <button onclick="deletePage('${escJsString(page.id)}')" class="danger">삭제</button>
          </td>
        </tr>`;
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
          <td><a href="${escAttr(revisionUrl)}" target="_blank">HTML 보기</a></td>
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
    body { font-family: sans-serif; max-width: 1100px; margin: 40px auto; padding: 0 20px; color: #222; }
    h1 { margin: 0 0 8px; }
    h2 { margin-top: 32px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    button { cursor: pointer; padding: 4px 8px; margin: 0 2px; }
    code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
    a { color: #0070f3; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .danger { color: red; }
    .muted { color: #666; }
    .comment-row td { background: #fafafa; }
    .comment { border: 1px solid #ddd; padding: 10px 12px; margin: 10px 0; background: white; }
    .comment p { margin: 0 0 8px; }
    .meta, .comment-meta { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 12px; }
    .meta div, .comment-meta div { display: contents; }
    dt { color: #666; font-weight: bold; }
    dd { margin: 0; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function managementScript() {
  return `<script>
    async function toggleVisibility(id, isPrivate) {
      const res = await fetch('/api/pages/' + id + '/visibility', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ private: isPrivate }),
      });
      if (res.ok) location.reload();
      else alert('전환 실패: ' + res.status);
    }
    async function deletePage(id) {
      if (!confirm('정말 삭제하시겠습니까?')) return;
      const res = await fetch('/api/pages/' + id, { method: 'DELETE' });
      if (res.ok) location.reload();
      else alert('삭제 실패: ' + res.status);
    }
  </script>`;
}

function emptyRow(colspan, label) {
  return `<tr><td colspan="${colspan}" style="text-align:center">${escHtml(label)}</td></tr>`;
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

function escJsString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

module.exports = {
  renderDashboard,
  renderDocumentDetail,
};
