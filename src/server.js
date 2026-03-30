'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');

// ── 필수 환경변수 검증 ──────────────────────────────────────────────────────
const REQUIRED_VARS = [
  'PORT', 'PAGES_DIR', 'PAGES_API_TOKEN', 'SESSION_SECRET',
  'BASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ALLOWED_EMAILS',
];
for (const key of REQUIRED_VARS) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const PORT = parseInt(process.env.PORT, 10);
const PAGES_DIR = process.env.PAGES_DIR;
const PAGES_API_TOKEN = process.env.PAGES_API_TOKEN;
const BASE_URL = process.env.BASE_URL; // trailing slash 없음, 예: https://pages.example.com
const ALLOWED_EMAILS = process.env.ALLOWED_EMAILS.split(',').map((e) => e.trim());

// ── PAGES_DIR 보장 ────────────────────────────────────────────────────────
fs.mkdirSync(PAGES_DIR, { recursive: true });

// ── pageId 유틸 ───────────────────────────────────────────────────────────
const newPageId = () => uuid().replace(/-/g, '').slice(0, 12);
const isValidPageId = (id) => /^[0-9a-f]{12}$/.test(id);

// ── Express 앱 설정 ────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // nginx 리버스 프록시 뒤에서 HTTPS 인식

app.use(express.json({ limit: '10mb' })); // 10MB 초과 시 자동 413

app.use(
  session({
    name: 'pages.sid', // 같은 도메인의 다른 서비스 쿠키와 충돌 방지
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, httpOnly: true },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ── Passport 설정 ─────────────────────────────────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: BASE_URL + '/auth/google/callback',
    },
    (accessToken, refreshToken, profile, done) => {
      const email = profile.emails?.[0]?.value;
      if (!email || !ALLOWED_EMAILS.includes(email)) {
        return done(null, false, { message: 'Unauthorized email' });
      }
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── 미들웨어 ──────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/google');
};

const requireBearerToken = (req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${PAGES_API_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ── 파일 경로 헬퍼 ────────────────────────────────────────────────────────
const htmlPath = (id) => path.join(PAGES_DIR, `${id}.html`);
const metaPath = (id) => path.join(PAGES_DIR, `${id}.json`);

const readMeta = (id) => {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
};

const writeMeta = (id, data) => {
  fs.writeFileSync(metaPath(id), JSON.stringify(data, null, 2), 'utf8');
};

// ── 라우트: Auth ──────────────────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/error' }),
  (req, res) => {
    const redirectTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(redirectTo);
  }
);

app.get('/auth/error', (req, res) => {
  res.status(403).send('<h1>403 Forbidden</h1><p>Access denied. Your Google account is not authorized.</p>');
});

app.get('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

// ── 라우트: API ───────────────────────────────────────────────────────────
// POST /api/pages — HTML 업로드
app.post('/api/pages', requireBearerToken, (req, res) => {
  const { html, title, private: isPrivate } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'html field is required' });
  }

  const id = newPageId();
  const meta = {
    id,
    title: title || '(제목 없음)',
    createdAt: new Date().toISOString(),
    private: isPrivate === true,
  };

  fs.writeFileSync(htmlPath(id), html, 'utf8');
  writeMeta(id, meta);

  res.status(201).json({ id, url: `${BASE_URL}/p/${id}` });
});

// PATCH /api/pages/:pageId/visibility — 공개/비공개 전환
app.patch('/api/pages/:pageId/visibility', requireAuth, (req, res) => {
  const { pageId } = req.params;
  if (!isValidPageId(pageId)) return res.status(404).json({ error: 'Not found' });

  const meta = readMeta(pageId);
  if (!meta) return res.status(404).json({ error: 'Not found' });

  const { private: isPrivate } = req.body;
  if (typeof isPrivate !== 'boolean') {
    return res.status(400).json({ error: 'private field must be boolean' });
  }

  meta.private = isPrivate;
  writeMeta(pageId, meta);
  res.json({ id: pageId, private: meta.private });
});

// DELETE /api/pages/:pageId — 페이지 삭제
app.delete('/api/pages/:pageId', requireAuth, (req, res) => {
  const { pageId } = req.params;
  if (!isValidPageId(pageId)) return res.status(404).json({ error: 'Not found' });

  const meta = readMeta(pageId);
  if (!meta) return res.status(404).json({ error: 'Not found' });

  try {
    fs.unlinkSync(htmlPath(pageId));
  } catch { /* 이미 없으면 무시 */ }
  try {
    fs.unlinkSync(metaPath(pageId));
  } catch { /* 이미 없으면 무시 */ }

  res.status(204).end();
});

// ── 라우트: 페이지 서빙 ───────────────────────────────────────────────────
app.get('/p/:pageId', (req, res, next) => {
  const { pageId } = req.params;
  if (!isValidPageId(pageId)) return res.status(404).send('<h1>404 Not Found</h1>');

  const meta = readMeta(pageId);
  if (!meta) return res.status(404).send('<h1>404 Not Found</h1>');

  if (meta.private && !req.isAuthenticated()) {
    return requireAuth(req, res, next);
  }

  try {
    const html = fs.readFileSync(htmlPath(pageId), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch {
    res.status(404).send('<h1>404 Not Found</h1>');
  }
});

// ── 라우트: 대시보드 ─────────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  // PAGES_DIR의 모든 .json 파일에서 메타 읽기
  const pages = [];
  try {
    const files = fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(PAGES_DIR, file), 'utf8'));
        pages.push(meta);
      } catch { /* 손상된 파일 무시 */ }
    }
  } catch { /* PAGES_DIR 읽기 실패 무시 */ }

  // createdAt 내림차순
  pages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const rows = pages.map((p) => {
    const url = `${BASE_URL}/p/${p.id}`;
    const visLabel = p.private ? '🔒 비공개' : '🌐 공개';
    const toggleLabel = p.private ? '공개로 전환' : '비공개로 전환';
    const toggleValue = p.private ? 'false' : 'true';
    return `
      <tr>
        <td><a href="${url}" target="_blank">${escHtml(p.title)}</a></td>
        <td>${visLabel}</td>
        <td>${escHtml(p.createdAt)}</td>
        <td>
          <button onclick="toggleVisibility('${p.id}', ${toggleValue})">${toggleLabel}</button>
          <button onclick="deletePage('${p.id}')" style="color:red">삭제</button>
        </td>
      </tr>`;
  }).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
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
</html>`);
});

// ── HTML 이스케이프 헬퍼 ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 서버 시작 ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[pages] Server running on port ${PORT}`);
  console.log(`[pages] BASE_URL: ${BASE_URL}`);
  console.log(`[pages] PAGES_DIR: ${PAGES_DIR}`);
});
