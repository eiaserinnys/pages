'use strict';

function renderDashboard({ pages, baseUrl }) {
  const rows = pages.map((page) => renderPageRow(page, baseUrl)).join('');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pages 대시보드</title>
  <style>
    body { font-family: sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f5f5f5; }
    button { cursor: pointer; padding: 4px 8px; margin: 0 2px; }
    a { color: #0070f3; }
  </style>
</head>
<body>
  <h1>Pages 대시보드</h1>
  <p>총 ${pages.length}개 페이지 | <a href="/auth/logout">로그아웃</a></p>
  <table>
    <thead>
      <tr><th>제목</th><th>공개 여부</th><th>생성일</th><th>관리</th></tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="4" style="text-align:center">페이지가 없습니다</td></tr>'}</tbody>
  </table>
  <script>
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
  </script>
</body>
</html>`;
}

function renderPageRow(page, baseUrl) {
  const url = `${baseUrl}/p/${page.id}`;
  const visLabel = page.private ? '🔒 비공개' : '🌐 공개';
  const toggleLabel = page.private ? '공개로 전환' : '비공개로 전환';
  const toggleValue = page.private ? 'false' : 'true';
  return `
      <tr>
        <td><a href="${url}" target="_blank">${escHtml(page.title)}</a></td>
        <td>${visLabel}</td>
        <td>${escHtml(page.createdAt)}</td>
        <td>
          <button onclick="toggleVisibility('${page.id}', ${toggleValue})">${toggleLabel}</button>
          <button onclick="deletePage('${page.id}')" style="color:red">삭제</button>
        </td>
      </tr>`;
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  renderDashboard,
};
