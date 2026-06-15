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
const { issueAnnotationToken, verifyAnnotationToken } = require('./capabilityTokens');
const { renderDashboard } = require('./dashboard');
const {
  DocumentStoreError,
  backfillDocumentMetadata,
  createDocumentStore,
  formatDocumentResponse,
  isValidDocumentSlug,
} = require('./documentStore');
const { injectReviewConfig } = require('./reviewBundle');
const { createWebhookSecretStore } = require('./webhookSecrets');
const {
  WebhookConfigurationError,
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

// ── PAGES_DIR 보장 ────────────────────────────────────────────────────────
fs.mkdirSync(PAGES_DIR, { recursive: true });
const metaDbPath = path.join(PAGES_DIR, 'pages-meta.sqlite');
const annotations = createAnnotationStore({
  dbPath: metaDbPath,
});
const documents = createDocumentStore({ dbPath: metaDbPath });
const webhookSecrets = createWebhookSecretStore({ dbPath: metaDbPath });

// ── pageId 유틸 ───────────────────────────────────────────────────────────
const newPageId = () => uuid().replace(/-/g, '').slice(0, 12);
const isValidPageId = (id) => /^[0-9a-f]{12}$/.test(id);
const isValidRevId = isValidPageId;

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
app.post('/api/pages', requireBearerToken, (req, res) => {
  const { html, title, private: isPrivate, reviewable, webhookUrl, webhookSecret, doc, owner } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'html field is required' });
  }
  if (reviewable !== true && (webhookUrl || webhookSecret)) {
    return res.status(400).json({ error: 'webhook requires reviewable=true' });
  }
  if (webhookSecret !== undefined && typeof webhookSecret !== 'string') {
    return res.status(400).json({ error: 'webhookSecret must be a string' });
  }
  if (webhookSecret && !webhookUrl) {
    return res.status(400).json({ error: 'webhookSecret requires webhookUrl' });
  }
  if (doc !== undefined && doc !== null && typeof doc !== 'string') {
    return res.status(400).json({ error: 'doc must be a string' });
  }
  if (owner !== undefined && owner !== null && typeof owner !== 'string') {
    return res.status(400).json({ error: 'owner must be a string' });
  }

  const id = newPageId();
  const pageTitle = title || '(제목 없음)';
  const createdAt = new Date().toISOString();
  const docSlug = doc === undefined || doc === null ? '' : doc;
  const wantsReviewable = reviewable === true;
  let review = null;
  let webhook = null;
  let documentRecord = null;
  let htmlToWrite = html;
  if (wantsReviewable) {
    const token = issueAnnotationToken({
      revId: id,
      secret: process.env.SESSION_SECRET,
      ttlSeconds: ANNOTATION_TOKEN_TTL_SECONDS,
    });
    review = {
      revId: id,
      annotationsUrl: `/api/annotations/${id}`,
      tokenHeader: ANNOTATION_TOKEN_HEADER,
      capabilityToken: token.token,
      expiresAt: token.expiresAt,
    };
    htmlToWrite = injectReviewConfig(html, review);
    try {
      webhook = normalizeReviewWebhook(id, webhookUrl, webhookSecret);
    } catch (err) {
      if (err instanceof WebhookConfigurationError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }
  try {
    if (docSlug) {
      documentRecord = documents.appendRevision({
        slug: docSlug,
        revId: id,
        title: pageTitle,
        owner,
        createdAt,
      });
    } else {
      documents.ensureAnonymousRevision({
        revId: id,
        title: pageTitle,
        owner,
        createdAt,
      });
    }
  } catch (err) {
    if (err instanceof DocumentStoreError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const meta = {
    id,
    title: pageTitle,
    createdAt,
    private: isPrivate === true,
  };
  if (documentRecord?.slug) {
    const revision = documentRecord.revision;
    meta.document = {
      docId: documentRecord.docId,
      slug: documentRecord.slug,
      owner: documentRecord.owner,
      revId: id,
      revNumber: revision.revNumber,
      stableUrl: `/d/${documentRecord.slug}`,
      revisionUrl: `/d/${documentRecord.slug}/r/${revision.revNumber}`,
    };
  }
  if (review) {
    meta.reviewable = true;
    meta.review = {
      revId: review.revId,
      annotationsUrl: review.annotationsUrl,
      tokenHeader: review.tokenHeader,
      expiresAt: review.expiresAt,
    };
    if (webhook) {
      meta.review.webhookUrl = webhook.url;
      if (webhook.secretHash) {
        meta.review.webhookSecretHash = webhook.secretHash;
      }
      review.webhook = {
        enabled: true,
        signed: Boolean(webhook.secretHash),
      };
    }
  }

  fs.writeFileSync(htmlPath(id), htmlToWrite, 'utf8');
  writeMeta(id, meta);

  const response = { id, url: `${BASE_URL}/p/${id}` };
  if (documentRecord?.slug) {
    const revision = documentRecord.revision;
    response.docId = documentRecord.docId;
    response.revId = id;
    response.revNumber = revision.revNumber;
    response.stableUrl = `${BASE_URL}/d/${documentRecord.slug}`;
    response.revisionUrl = `${BASE_URL}/d/${documentRecord.slug}/r/${revision.revNumber}`;
  }
  if (review) response.review = review;
  res.status(201).json(response);
});

// GET /api/documents/:slug — document metadata with revision list
app.get('/api/documents/:slug', (req, res) => {
  const { slug } = req.params;
  if (!isValidDocumentSlug(slug)) return res.status(404).json({ error: 'Not found' });

  const documentRecord = documents.getDocument(slug);
  if (!documentRecord) return res.status(404).json({ error: 'Not found' });

  const latestMeta = documentRecord.latestRevision ? readMeta(documentRecord.latestRevision) : null;
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

  const meta = readMeta(revId);
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

  const meta = readMeta(revId);
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
app.get('/d/:slug', (req, res) => {
  const { slug } = req.params;
  if (!isValidDocumentSlug(slug)) return res.status(404).send('<h1>404 Not Found</h1>');

  const documentRecord = documents.getDocument(slug);
  if (!documentRecord?.revision) return res.status(404).send('<h1>404 Not Found</h1>');

  res.redirect(302, `/d/${slug}/r/${documentRecord.revision.revNumber}`);
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

  return sendPageHtml(req, res, next, revision.revId);
});

app.get('/p/:pageId', (req, res, next) => {
  const { pageId } = req.params;
  if (!isValidPageId(pageId)) return res.status(404).send('<h1>404 Not Found</h1>');

  return sendPageHtml(req, res, next, pageId);
});

function sendPageHtml(req, res, next, pageId) {
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
}

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

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDashboard({ pages, baseUrl: BASE_URL }));
});

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
