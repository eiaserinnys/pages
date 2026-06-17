'use strict';
require('dotenv').config({ override: true });

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const { AnnotationStoreError, createAnnotationStore } = require('./annotationStore');
const { BundleStoreError, createBundleStore } = require('./bundleStore');
const { verifyAnnotationToken } = require('./capabilityTokens');
const { renderDashboard, renderDocumentDetail } = require('./dashboard');
const {
  backfillDocumentMetadata,
  createDocumentStore,
  formatDocumentResponse,
  isValidDocumentSlug,
} = require('./documentStore');
const { createPageStorage } = require('./pageStorage');
const { createPageUploadHandler } = require('./pageUpload');
const { createWebhookSecretStore } = require('./webhookSecrets');
const {
  buildAnnotationWebhookEvent,
  normalizeWebhookUrl,
  queueAnnotationWebhook,
} = require('./webhooks');

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
const ANNOTATION_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const ANNOTATION_TOKEN_HEADER = 'X-Pages-Annotation-Token';
const DASHBOARD_DEFAULT_PAGE_SIZE = 25;
const DASHBOARD_MAX_PAGE_SIZE = 100;

// ── PAGES_DIR 보장 ────────────────────────────────────────────────────────
fs.mkdirSync(PAGES_DIR, { recursive: true });
const metaDbPath = path.join(PAGES_DIR, 'pages-meta.sqlite');
const annotations = createAnnotationStore({
  dbPath: metaDbPath,
});
const documents = createDocumentStore({ dbPath: metaDbPath });
const bundles = createBundleStore({ dbPath: metaDbPath, pagesDir: PAGES_DIR });
const pageStorage = createPageStorage({ pagesDir: PAGES_DIR });
const webhookSecrets = createWebhookSecretStore({ dbPath: metaDbPath });

// ── pageId 유틸 ───────────────────────────────────────────────────────────
const newPageId = () => uuid().replace(/-/g, '').slice(0, 12);
const isValidPageId = (id) => /^[0-9a-f]{12}$/.test(id);
const isValidRevId = isValidPageId;

// ── Express 앱 설정 ────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // nginx 리버스 프록시 뒤에서 HTTPS 인식

app.use(express.json({ limit: '75mb' })); // 50MB bundle + base64 JSON overhead

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

backfillDocumentMetadata({ pagesDir: PAGES_DIR, documents });

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
app.post('/api/pages', requireBearerToken, createPageUploadHandler({
  documents,
  bundles,
  pageStorage,
  newPageId,
  baseUrl: BASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
  annotationTokenTtlSeconds: ANNOTATION_TOKEN_TTL_SECONDS,
  annotationTokenHeader: ANNOTATION_TOKEN_HEADER,
  normalizeReviewWebhook,
}));

// GET /api/documents/:slug — document metadata with revision list
app.get('/api/documents/:slug', (req, res) => {
  const { slug } = req.params;
  if (!isValidDocumentSlug(slug)) return res.status(404).json({ error: 'Not found' });

  const documentRecord = documents.getDocument(slug);
  if (!documentRecord) return res.status(404).json({ error: 'Not found' });

  const latestMeta = documentRecord.latestRevision ? pageStorage.readMeta(documentRecord.latestRevision) : null;
  if (latestMeta?.private && !req.isAuthenticated()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json(formatDocumentResponse(documentRecord, BASE_URL));
});

// GET /api/annotations/:revId — reviewable revision comments
app.get('/api/annotations/:revId', (req, res) => {
  const { revId } = req.params;
  if (!isValidRevId(revId)) return res.status(404).json({ error: 'Not found' });

  const meta = pageStorage.readMeta(revId);
  if (!meta || meta.reviewable !== true) return res.status(404).json({ error: 'Not found' });

  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(annotations.list(revId));
  } catch (err) {
    console.error('[pages] failed to read annotations', err);
    res.status(500).json({ error: 'Failed to read annotations' });
  }
});

// PUT /api/annotations/:revId — full replacement for one reviewable revision
app.put('/api/annotations/:revId', (req, res) => {
  const { revId } = req.params;
  if (!isValidRevId(revId)) return res.status(404).json({ error: 'Not found' });

  const meta = pageStorage.readMeta(revId);
  if (!meta || meta.reviewable !== true) return res.status(404).json({ error: 'Not found' });

  const tokenResult = verifyAnnotationToken(readAnnotationToken(req), {
    revId,
    secret: process.env.SESSION_SECRET,
  });
  if (!tokenResult.ok) {
    return res.status(401).json({ error: 'Unauthorized', reason: tokenResult.error });
  }

  try {
    documents.ensureRevisionFromMeta(meta);
    const payload = annotations.replace(revId, req.body);
    queueAnnotationWebhook({
      url: meta.review?.webhookUrl,
      secret: webhookSecrets.get(revId),
      payload: buildAnnotationWebhookEvent({
        revId,
        count: payload.comments.length,
      }),
    });
    res.json({ ok: true, revId, count: payload.comments.length });
  } catch (err) {
    if (err instanceof AnnotationStoreError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[pages] failed to write annotations', err);
    res.status(500).json({ error: 'Failed to write annotations' });
  }
});

// PATCH /api/pages/:pageId/visibility — 공개/비공개 전환
app.patch('/api/pages/:pageId/visibility', requireAuth, (req, res) => {
  const { pageId } = req.params;
  if (!isValidPageId(pageId)) return res.status(404).json({ error: 'Not found' });

  const meta = pageStorage.readMeta(pageId);
  if (!meta) return res.status(404).json({ error: 'Not found' });

  const { private: isPrivate } = req.body;
  if (typeof isPrivate !== 'boolean') {
    return res.status(400).json({ error: 'private field must be boolean' });
  }

  meta.private = isPrivate;
  pageStorage.writeMeta(pageId, meta);
  res.json({ id: pageId, private: meta.private });
});

// DELETE /api/pages/:pageId — 페이지 삭제
app.delete('/api/pages/:pageId', requireAuth, (req, res) => {
  const { pageId } = req.params;
  if (!isValidPageId(pageId)) return res.status(404).json({ error: 'Not found' });

  const meta = pageStorage.readMeta(pageId);
  if (!meta) return res.status(404).json({ error: 'Not found' });

  try {
    pageStorage.deletePage(pageId);
  } catch { /* 이미 없으면 무시 */ }

  res.status(204).end();
});

// ── 라우트: 페이지 서빙 ───────────────────────────────────────────────────
app.get('/d/:slug', (req, res) => {
  const { slug } = req.params;
  if (!isValidDocumentSlug(slug)) return res.status(404).send('<h1>404 Not Found</h1>');

  const documentRecord = documents.getDocument(slug);
  if (!documentRecord?.revision) return res.status(404).send('<h1>404 Not Found</h1>');

  const latestPath = `/d/${slug}/r/${documentRecord.revision.revNumber}`;
  res.redirect(302, appendOriginalQuery(req, hasTrailingSlash(req) ? `${latestPath}/` : latestPath));
});

app.get('/d/:slug/r/:revNumber', (req, res, next) => {
  const { slug, revNumber } = req.params;
  if (!isValidDocumentSlug(slug)) return res.status(404).send('<h1>404 Not Found</h1>');
  const revisionNumber = Number(revNumber);
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
    return res.status(404).send('<h1>404 Not Found</h1>');
  }

  const revision = documents.getRevisionBySlugNumber(slug, revisionNumber);
  if (!revision) return res.status(404).send('<h1>404 Not Found</h1>');
  if (!hasTrailingSlash(req)) return redirectToTrailingSlash(req, res);

  return sendPageAsset(req, res, next, revision.revId);
});

app.get('/d/:slug/r/:revNumber/*', (req, res, next) => {
  const { slug, revNumber } = req.params;
  if (!isValidDocumentSlug(slug)) return res.status(404).send('<h1>404 Not Found</h1>');
  const revisionNumber = Number(revNumber);
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
    return res.status(404).send('<h1>404 Not Found</h1>');
  }

  const revision = documents.getRevisionBySlugNumber(slug, revisionNumber);
  if (!revision) return res.status(404).send('<h1>404 Not Found</h1>');

  return sendPageAsset(req, res, next, revision.revId, req.params[0]);
});

app.get('/d/:slug/*', (req, res, next) => {
  const { slug } = req.params;
  if (!isValidDocumentSlug(slug)) return res.status(404).send('<h1>404 Not Found</h1>');

  const documentRecord = documents.getDocument(slug);
  if (!documentRecord?.revision) return res.status(404).send('<h1>404 Not Found</h1>');

  return sendPageAsset(req, res, next, documentRecord.revision.revId, req.params[0]);
});

app.get('/p/:pageId', (req, res, next) => {
  const { pageId } = req.params;
  if (!isValidPageId(pageId)) return res.status(404).send('<h1>404 Not Found</h1>');
  if (!hasTrailingSlash(req)) return redirectToTrailingSlash(req, res);

  return sendPageAsset(req, res, next, pageId);
});

app.get('/p/:pageId/*', (req, res, next) => {
  const { pageId } = req.params;
  if (!isValidPageId(pageId)) return res.status(404).send('<h1>404 Not Found</h1>');

  return sendPageAsset(req, res, next, pageId, req.params[0]);
});

function sendPageAsset(req, res, next, pageId, assetPath = '') {
  const meta = pageStorage.readMeta(pageId);
  if (!meta) return res.status(404).send('<h1>404 Not Found</h1>');

  if (meta.private && !req.isAuthenticated()) {
    return requireAuth(req, res, next);
  }

  try {
    const asset = bundles.getAsset(pageId, assetPath);
    if (asset) return streamBundleAsset(res, asset);
  } catch (err) {
    if (err instanceof BundleStoreError) {
      return res.status(404).send('<h1>404 Not Found</h1>');
    }
    throw err;
  }
  if (assetPath) return res.status(404).send('<h1>404 Not Found</h1>');

  try {
    const html = pageStorage.readHtml(pageId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch {
    return res.status(404).send('<h1>404 Not Found</h1>');
  }
}

function streamBundleAsset(res, asset) {
  const filePath = bundles.resolveAssetFile(asset);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.status(404).send('<h1>404 Not Found</h1>');
  } catch {
    return res.status(404).send('<h1>404 Not Found</h1>');
  }
  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('Content-Length', String(asset.sizeBytes));
  return fs.createReadStream(filePath).pipe(res);
}

function hasTrailingSlash(req) {
  return req.path.endsWith('/');
}

function redirectToTrailingSlash(req, res) {
  const queryIndex = req.originalUrl.indexOf('?');
  const pathname = queryIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
  return res.redirect(302, `${pathname}/${query}`);
}

function appendOriginalQuery(req, targetPath) {
  const queryIndex = req.originalUrl.indexOf('?');
  return queryIndex === -1 ? targetPath : `${targetPath}${req.originalUrl.slice(queryIndex)}`;
}

// ── 라우트: 대시보드 ─────────────────────────────────────────────────────
app.get('/api/dashboard/documents', requireAuth, (req, res) => {
  res.json(paginateItems(documents.listDocuments(), dashboardPagination(req)));
});

app.get('/api/dashboard/pages', requireAuth, (req, res) => {
  res.json(paginateItems(listAnonymousPages(), dashboardPagination(req)));
});

app.get('/', requireAuth, sendDashboard);
app.get('/dashboard', requireAuth, sendDashboard);

app.get('/dashboard/documents/:slug', requireAuth, (req, res) => {
  const { slug } = req.params;
  if (!isValidDocumentSlug(slug)) return res.status(404).send('<h1>404 Not Found</h1>');

  const documentRecord = documents.getDocument(slug);
  if (!documentRecord) return res.status(404).send('<h1>404 Not Found</h1>');

  const revisionIds = documentRecord.revisions.map((revision) => revision.revId);
  const commentCounts = annotations.countByRevisionIds(revisionIds);
  const revisions = documentRecord.revisions.map((revision) => {
    const meta = pageStorage.readMeta(revision.revId);
    return {
      ...revision,
      reviewable: meta?.reviewable === true,
      commentCount: commentCounts[revision.revId] || 0,
      comments: annotations.list(revision.revId).comments,
    };
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDocumentDetail({ documentRecord, revisions, baseUrl: BASE_URL }));
});

function sendDashboard(req, res) {
  const pages = paginateItems(listAnonymousPages(), { page: 1, pageSize: DASHBOARD_DEFAULT_PAGE_SIZE });
  const documentRecords = paginateItems(documents.listDocuments(), { page: 1, pageSize: DASHBOARD_DEFAULT_PAGE_SIZE });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDashboard({ pages, documents: documentRecords, baseUrl: BASE_URL }));
}

function listAnonymousPages() {
  const pages = pageStorage
    .listMetas()
    .filter((page) => !page.document?.slug);
  pages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return pages;
}

function dashboardPagination(req) {
  const page = positiveInteger(req.query.page) || 1;
  const requestedPageSize = positiveInteger(req.query.pageSize) || DASHBOARD_DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, DASHBOARD_MAX_PAGE_SIZE);
  return { page, pageSize };
}

function paginateItems(items, { page, pageSize }) {
  const total = items.length;
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  const normalizedPage = totalPages ? Math.min(Math.max(page, 1), totalPages) : 0;
  const offset = normalizedPage ? (normalizedPage - 1) * pageSize : 0;
  return {
    items: totalPages ? items.slice(offset, offset + pageSize) : [],
    page: normalizedPage,
    pageSize,
    total,
    totalPages,
  };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function readAnnotationToken(req) {
  const headerToken = req.get(ANNOTATION_TOKEN_HEADER);
  if (headerToken) return headerToken;
  const auth = req.get('authorization') || '';
  const match = auth.match(/^Capability\s+(.+)$/i);
  return match ? match[1] : '';
}

function normalizeReviewWebhook(revId, webhookUrl, webhookSecret) {
  const url = normalizeWebhookUrl(webhookUrl);
  if (!url) return null;
  const secret = typeof webhookSecret === 'string' ? webhookSecret : '';
  const secretHash = webhookSecrets.save(revId, secret);
  return { url, secretHash };
}

// ── 서버 시작 ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[pages] Server running on port ${PORT}`);
  console.log(`[pages] BASE_URL: ${BASE_URL}`);
  console.log(`[pages] PAGES_DIR: ${PAGES_DIR}`);
});
