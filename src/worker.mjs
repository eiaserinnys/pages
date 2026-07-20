import dashboardModule from './dashboard.js';
import {
  dashboardQuery as readDashboardQuery,
  deleteDashboardPageData,
  getDashboardDocumentDetail,
  getDashboardPageDetail,
  listDashboardDocuments,
  listDashboardPages,
} from './workerDashboard.mjs';

const {
  renderDashboard: renderModernDashboard,
  renderDocumentDetail: renderModernDocumentDetail,
} = dashboardModule;

const PAGE_ID_RE = /^[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const RESERVED_SLUGS = new Set([
  "api",
  "auth",
  "d",
  "dashboard",
  "login",
  "logout",
  "p",
  "static",
]);
const STATUS_VALUES = new Set(["needs_agent_review", "needs_user_reply", "resolved"]);
const MAX_BUNDLE_FILES = 200;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_REQUEST_BYTES = 75 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_SEGMENT_LENGTH = 128;
const INDEX_ENTRYPOINT = "index.html";
const ANNOTATION_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const ANNOTATION_TOKEN_HEADER = "X-Pages-Annotation-Token";
const SESSION_COOKIE = "pages.session";
const OAUTH_STATE_COOKIE = "pages.oauth_state";
const RETURN_TO_COOKIE = "pages.return_to";
const WEBHOOK_TIMEOUT_MS = 5000;
const DEFAULT_OWNER = "api";
const PUBLISHED_STATUS = "published";
const DASHBOARD_DEFAULT_PAGE_SIZE = 25;
const DASHBOARD_MAX_PAGE_SIZE = 100;
const DASHBOARD_ROW_HEIGHT = 96;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".pdf", "application/pdf"],
  [".wasm", "application/wasm"],
  [".xml", "application/xml; charset=utf-8"],
]);

export default {
  async fetch(request, env, ctx) {
    try {
      assertRequiredEnv(env);
      return await routeRequest(request, env, ctx);
    } catch (err) {
      console.error("[pages-worker] request failed", err);
      return json({ error: "Internal server error" }, 500);
    }
  },
};

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/auth/google") return startGoogleAuth(request, env);
  if (request.method === "GET" && pathname === "/auth/google/callback") return completeGoogleAuth(request, env);
  if (request.method === "GET" && pathname === "/auth/logout") return logout();
  if (request.method === "GET" && pathname === "/auth/error") {
    return html("<h1>403 Forbidden</h1><p>Access denied. Your Google account is not authorized.</p>", 403);
  }

  if (request.method === "POST" && pathname === "/api/pages") return uploadPage(request, env);

  if (request.method === "GET" && pathname === "/api/dashboard/documents") {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    return listDashboardDocumentsApi(request, env);
  }

  if (request.method === "GET" && pathname === "/api/dashboard/pages") {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    return listDashboardPagesApi(request, env);
  }

  const dashboardDocumentApiMatch = pathname.match(/^\/api\/dashboard\/documents\/([^/]+)$/);
  if (request.method === "GET" && dashboardDocumentApiMatch) {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    const slug = safeDecodeURIComponent(dashboardDocumentApiMatch[1]);
    if (!isValidDocumentSlug(slug)) return json({ error: "Not found" }, 404);
    const detail = await getDashboardDocumentDetail(env, slug, env.BASE_URL);
    return detail ? json(detail) : json({ error: "Not found" }, 404);
  }

  const dashboardPageApiMatch = pathname.match(/^\/api\/dashboard\/pages\/([0-9a-f]{12})$/);
  if (request.method === "GET" && dashboardPageApiMatch) {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    const detail = await getDashboardPageDetail(env, dashboardPageApiMatch[1], env.BASE_URL);
    return detail ? json(detail) : json({ error: "Not found" }, 404);
  }

  const documentApiMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (request.method === "GET" && documentApiMatch) {
    return getDocumentApi(request, env, decodeURIComponent(documentApiMatch[1]));
  }

  const annotationMatch = pathname.match(/^\/api\/annotations\/([0-9a-f]{12})$/);
  if (annotationMatch && request.method === "GET") return listAnnotations(env, annotationMatch[1]);
  if (annotationMatch && request.method === "PUT") return replaceAnnotations(request, env, ctx, annotationMatch[1]);

  const visibilityMatch = pathname.match(/^\/api\/pages\/([0-9a-f]{12})\/visibility$/);
  if (visibilityMatch && request.method === "PATCH") {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    return updateVisibility(request, env, visibilityMatch[1]);
  }

  const deleteMatch = pathname.match(/^\/api\/pages\/([0-9a-f]{12})$/);
  if (deleteMatch && request.method === "DELETE") {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    return deletePage(env, deleteMatch[1]);
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    return sendDashboard(env);
  }

  const dashboardDocMatch = pathname.match(/^\/dashboard\/documents\/([^/]+)$/);
  if (request.method === "GET" && dashboardDocMatch) {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    return sendDocumentDashboard(env, decodeURIComponent(dashboardDocMatch[1]));
  }

  if (request.method === "GET") {
    const documentAsset = await maybeServeDocumentRoute(request, env);
    if (documentAsset) return documentAsset;
    const pageAsset = await maybeServePageRoute(request, env);
    if (pageAsset) return pageAsset;
  }

  return notFound();
}

function assertRequiredEnv(env) {
  for (const key of [
    "PAGES_BUCKET",
    "PAGES_DB",
    "PAGES_API_TOKEN",
    "SESSION_SECRET",
    "BASE_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ALLOWED_EMAILS",
  ]) {
    if (!env[key]) throw new Error(`Missing required binding or variable: ${key}`);
  }
}

async function uploadPage(request, env) {
  if (!hasBearerToken(request, env.PAGES_API_TOKEN)) return json({ error: "Unauthorized" }, 401);
  if (Number(request.headers.get("content-length") || 0) > MAX_REQUEST_BYTES) {
    return json({ error: "Request body exceeds 75 MB limit" }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }

  let bundle;
  try {
    bundle = normalizeUploadBundle(body);
  } catch (err) {
    return json({ error: err.message }, err.statusCode || 400);
  }

  const validationError = validateUploadOptions(body);
  if (validationError) return json({ error: validationError }, 400);

  const id = newPageId();
  const title = titleValue(body.title);
  const owner = ownerValue(body.owner);
  const createdAt = new Date().toISOString();
  const wantsReviewable = body.reviewable === true;

  let review = null;
  let webhook = null;
  if (wantsReviewable) {
    review = await issueAnnotationToken({
      revId: id,
      secret: env.SESSION_SECRET,
      ttlSeconds: ANNOTATION_TOKEN_TTL_SECONDS,
    });
    review = {
      revId: id,
      annotationsUrl: `/api/annotations/${id}`,
      tokenHeader: ANNOTATION_TOKEN_HEADER,
      capabilityToken: review.token,
      expiresAt: review.expiresAt,
    };
    try {
      bundle = withPatchedEntrypoint(bundle, (entryHtml) => injectReviewConfig(entryHtml, review));
      webhook = await normalizeAndSaveWebhook(env, id, body.webhookUrl, body.webhookSecret);
    } catch (err) {
      return json({ error: err.message }, err.statusCode || 400);
    }
  }

  let documentRecord;
  try {
    documentRecord = body.doc ? await appendRevision(env, {
      slug: body.doc,
      revId: id,
      title,
      owner,
      createdAt,
    }) : await ensureAnonymousRevision(env, {
      revId: id,
      title,
      owner,
      createdAt,
    });
  } catch (err) {
    return json({ error: err.message }, 400);
  }

  const revisionDocument = await getRevisionDocument(env, id);
  if (!revisionDocument) return json({ error: "Failed to create revision metadata" }, 500);

  let manifest;
  try {
    manifest = await replaceBundle(env, {
      revId: id,
      docId: revisionDocument.docId,
      entrypoint: bundle.entrypoint,
      files: bundle.files,
      createdAt,
    });
  } catch (err) {
    return json({ error: err.message }, err.statusCode || 400);
  }

  const meta = buildPageMeta({
    id,
    title,
    createdAt,
    isPrivate: body.private === true,
    documentRecord,
    review,
    webhook,
    manifest,
  });
  await writeMeta(env, id, meta);

  const entrypointFile = bundle.files.find((file) => file.path === bundle.entrypoint);
  await env.PAGES_BUCKET.put(pageHtmlKey(id), entrypointFile.bytes, {
    httpMetadata: { contentType: entrypointFile.contentType },
  });

  return json(buildUploadResponse({ id, baseUrl: env.BASE_URL, documentRecord, review }), 201);
}

function validateUploadOptions({ reviewable, webhookUrl, webhookSecret, doc, owner }) {
  if (reviewable !== true && (webhookUrl || webhookSecret)) return "webhook requires reviewable=true";
  if (webhookSecret !== undefined && typeof webhookSecret !== "string") return "webhookSecret must be a string";
  if (webhookSecret && !webhookUrl) return "webhookSecret requires webhookUrl";
  if (doc !== undefined && doc !== null && typeof doc !== "string") return "doc must be a string";
  if (owner !== undefined && owner !== null && typeof owner !== "string") return "owner must be a string";
  return "";
}

function buildPageMeta({ id, title, createdAt, isPrivate, documentRecord, review, webhook, manifest }) {
  const meta = {
    id,
    title,
    createdAt,
    private: isPrivate,
    bundle: {
      entrypoint: manifest.entrypoint,
      fileCount: manifest.fileCount,
      totalSizeBytes: manifest.totalSizeBytes,
      assets: manifest.assets,
    },
  };
  if (documentRecord?.slug) {
    meta.document = {
      docId: documentRecord.docId,
      slug: documentRecord.slug,
      owner: documentRecord.owner,
      revId: id,
      revNumber: documentRecord.revision.revNumber,
      stableUrl: `/d/${documentRecord.slug}`,
      revisionUrl: `/d/${documentRecord.slug}/r/${documentRecord.revision.revNumber}`,
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
      if (webhook.secretHash) meta.review.webhookSecretHash = webhook.secretHash;
      review.webhook = {
        enabled: true,
        signed: Boolean(webhook.secretHash),
      };
    }
  }
  return meta;
}

function buildUploadResponse({ id, baseUrl, documentRecord, review }) {
  const response = { id, url: `${baseUrl}/p/${id}` };
  if (documentRecord?.slug) {
    response.docId = documentRecord.docId;
    response.revId = id;
    response.revNumber = documentRecord.revision.revNumber;
    response.stableUrl = `${baseUrl}/d/${documentRecord.slug}`;
    response.revisionUrl = `${baseUrl}/d/${documentRecord.slug}/r/${documentRecord.revision.revNumber}`;
  }
  if (review) response.review = review;
  return response;
}

async function maybeServePageRoute(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/p\/([0-9a-f]{12})(?:\/(.*))?$/);
  if (!match) return null;
  const [, pageId, assetPathRaw] = match;
  if (url.pathname === `/p/${pageId}`) return redirect(`${url.origin}/p/${pageId}/${url.search}`);
  return sendPageAsset(request, env, pageId, assetPathRaw || "");
}

async function maybeServeDocumentRoute(request, env) {
  const url = new URL(request.url);
  const revisionAsset = url.pathname.match(/^\/d\/([^/]+)\/r\/([0-9]+)(?:\/(.*))?$/);
  if (revisionAsset) {
    const slug = decodeURIComponent(revisionAsset[1]);
    if (!isValidDocumentSlug(slug)) return notFound();
    const revNumber = Number(revisionAsset[2]);
    if (!Number.isInteger(revNumber) || revNumber < 1) return notFound();
    const revision = await getRevisionBySlugNumber(env, slug, revNumber);
    if (!revision) return notFound();
    if (url.pathname === `/d/${slug}/r/${revNumber}`) return redirect(`${url.origin}/d/${slug}/r/${revNumber}/${url.search}`);
    return sendPageAsset(request, env, revision.revId, revisionAsset[3] || "");
  }

  const latestAsset = url.pathname.match(/^\/d\/([^/]+)(?:\/(.*))?$/);
  if (!latestAsset) return null;
  const slug = decodeURIComponent(latestAsset[1]);
  if (!isValidDocumentSlug(slug)) return notFound();
  const documentRecord = await getDocument(env, slug);
  if (!documentRecord?.revision) return notFound();
  if (latestAsset[2] === undefined) {
    return redirect(`${url.origin}/d/${slug}/${url.search}`);
  }
  return sendPageAsset(request, env, documentRecord.revision.revId, latestAsset[2] || "");
}

async function sendPageAsset(request, env, pageId, assetPath = "") {
  const meta = await readMeta(env, pageId);
  if (!meta) return notFound();
  if (meta.private) {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
  }

  let asset;
  try {
    asset = await getAsset(env, pageId, assetPath);
  } catch {
    return notFound();
  }

  if (!asset && assetPath) return notFound();
  if (!asset) {
    const object = await env.PAGES_BUCKET.get(pageHtmlKey(pageId));
    if (!object) return notFound();
    return objectResponse(object, "text/html; charset=utf-8");
  }

  const object = await env.PAGES_BUCKET.get(asset.bytesKey);
  if (!object) return notFound();
  return objectResponse(object, asset.contentType);
}

async function getDocumentApi(request, env, slug) {
  if (!isValidDocumentSlug(slug)) return json({ error: "Not found" }, 404);
  const documentRecord = await getDocument(env, slug);
  if (!documentRecord) return json({ error: "Not found" }, 404);
  const latestMeta = documentRecord.latestRevision ? await readMeta(env, documentRecord.latestRevision) : null;
  if (latestMeta?.private) {
    const auth = await requireAuth(request, env, { json: true });
    if (auth.response) return auth.response;
  }
  return json(formatDocumentResponse(documentRecord, env.BASE_URL));
}

async function updateVisibility(request, env, pageId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }
  if (typeof body.private !== "boolean") return json({ error: "private field must be boolean" }, 400);
  const meta = await readMeta(env, pageId);
  if (!meta) return json({ error: "Not found" }, 404);
  meta.private = body.private;
  await writeMeta(env, pageId, meta);
  return json({ id: pageId, private: meta.private });
}

async function deletePage(env, pageId) {
  const meta = await readMeta(env, pageId);
  if (!meta) return json({ error: "Not found" }, 404);
  const deleted = await deleteDashboardPageData(env, pageId);
  await env.PAGES_BUCKET.delete([
    pageMetaKey(pageId),
    pageHtmlKey(pageId),
    ...deleted.assetKeys,
  ]);
  return new Response(null, { status: 204 });
}

async function listAnnotations(env, revId) {
  const meta = await readMeta(env, revId);
  if (!meta || meta.reviewable !== true) return json({ error: "Not found" }, 404);
  return json(await getCommentsPayload(env, revId));
}

async function replaceAnnotations(request, env, ctx, revId) {
  const meta = await readMeta(env, revId);
  if (!meta || meta.reviewable !== true) return json({ error: "Not found" }, 404);

  const token = readAnnotationToken(request);
  const tokenResult = await verifyAnnotationToken(token, { revId, secret: env.SESSION_SECRET });
  if (!tokenResult.ok) return json({ error: "Unauthorized", reason: tokenResult.error }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }

  let payload;
  try {
    payload = normalizeCommentsPayload(revId, body);
  } catch (err) {
    return json({ error: err.message }, 400);
  }

  await env.PAGES_DB.prepare("DELETE FROM comments WHERE rev_id = ?").bind(revId).run();
  for (const comment of payload.comments) {
    const now = new Date().toISOString();
    const anchor = {
      document_id: comment.document_id,
      block_id: comment.block_id,
      selected_text: comment.selected_text,
      prefix: comment.prefix,
      suffix: comment.suffix,
    };
    await env.PAGES_DB.prepare(`
      INSERT INTO comments (
        comment_id, rev_id, anchor, body, author, created_at, resolved, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      comment.id,
      revId,
      JSON.stringify(anchor),
      comment.comment,
      comment.author || "reviewer",
      comment.created_at,
      comment.status === "resolved" ? 1 : 0,
      JSON.stringify(comment),
      now,
    ).run();
  }

  const webhookSecret = await getWebhookSecret(env, revId);
  if (meta.review?.webhookUrl) {
    const event = buildAnnotationWebhookEvent({ revId, count: payload.comments.length });
    ctx.waitUntil(postAnnotationWebhook({ url: meta.review.webhookUrl, payload: event, secret: webhookSecret }));
  }
  return json({ ok: true, revId, count: payload.comments.length });
}

async function sendDashboard(env) {
  const initialQuery = { cursor: 0, limit: 24, q: "" };
  const [pages, documents] = await Promise.all([
    listDashboardPages(env, initialQuery),
    listDashboardDocuments(env, initialQuery),
  ]);
  return html(renderModernDashboard({ pages, documents, baseUrl: env.BASE_URL }));
}

async function listDashboardDocumentsApi(request, env) {
  return json(await listDashboardDocuments(env, readDashboardQuery(request)));
}

async function listDashboardPagesApi(request, env) {
  return json(await listDashboardPages(env, readDashboardQuery(request)));
}

async function sendDocumentDashboard(env, slug) {
  if (!isValidDocumentSlug(slug)) return notFound();
  const documentRecord = await getDocument(env, slug);
  if (!documentRecord) return notFound();
  const revisionIds = documentRecord.revisions.map((revision) => revision.revId);
  const commentCounts = await countCommentsByRevisionIds(env, revisionIds);
  const revisions = [];
  for (const revision of documentRecord.revisions) {
    const meta = await readMeta(env, revision.revId);
    const comments = await getCommentsPayload(env, revision.revId);
    revisions.push({
      ...revision,
      reviewable: meta?.reviewable === true,
      commentCount: commentCounts[revision.revId] || 0,
      comments: comments.comments,
    });
  }
  return html(renderModernDocumentDetail({ documentRecord, revisions, baseUrl: env.BASE_URL }));
}

async function appendRevision(env, input) {
  const slug = normalizeSlug(input.slug);
  const now = input.createdAt || new Date().toISOString();
  let doc = await selectDocumentBySlug(env, slug);
  if (!doc) {
    doc = {
      docId: newDocId(),
      slug,
      title: titleValue(input.title),
      owner: ownerValue(input.owner),
      latestRevision: null,
      createdAt: now,
      updatedAt: now,
    };
    await env.PAGES_DB.prepare(`
      INSERT INTO documents (doc_id, slug, title, owner, latest_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `).bind(doc.docId, doc.slug, doc.title, doc.owner, now, now).run();
  }

  const maxRow = await env.PAGES_DB.prepare(`
    SELECT COALESCE(MAX(rev_number), 0) AS max_rev_number
    FROM revisions
    WHERE doc_id = ?
  `).bind(doc.docId).first();
  const revNumber = Number(maxRow?.max_rev_number || 0) + 1;
  await env.PAGES_DB.prepare(`
    INSERT INTO revisions (rev_id, doc_id, rev_number, status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(input.revId, doc.docId, revNumber, PUBLISHED_STATUS, now).run();
  await env.PAGES_DB.prepare(`
    UPDATE documents
    SET title = ?, owner = ?, latest_revision = ?, updated_at = ?
    WHERE doc_id = ?
  `).bind(titleValue(input.title), ownerValue(input.owner), input.revId, now, doc.docId).run();
  return getDocument(env, slug);
}

async function ensureAnonymousRevision(env, input) {
  const now = input.createdAt || new Date().toISOString();
  const docId = anonymousDocId(input.revId);
  await env.PAGES_DB.prepare(`
    INSERT OR IGNORE INTO documents (doc_id, slug, title, owner, latest_revision, created_at, updated_at)
    VALUES (?, NULL, ?, ?, NULL, ?, ?)
  `).bind(docId, titleValue(input.title), ownerValue(input.owner), now, now).run();
  await env.PAGES_DB.prepare(`
    UPDATE documents
    SET title = ?, owner = ?, updated_at = ?
    WHERE doc_id = ?
  `).bind(titleValue(input.title), ownerValue(input.owner), now, docId).run();
  await env.PAGES_DB.prepare(`
    INSERT OR IGNORE INTO revisions (rev_id, doc_id, rev_number, status, created_at)
    VALUES (?, ?, 1, ?, ?)
  `).bind(input.revId, docId, PUBLISHED_STATUS, now).run();
  await env.PAGES_DB.prepare(`
    UPDATE documents
    SET latest_revision = ?, updated_at = ?
    WHERE doc_id = ?
  `).bind(input.revId, now, docId).run();
  return getDocumentById(env, docId);
}

async function getDocument(env, slug) {
  const normalized = normalizeSlug(slug);
  const doc = await selectDocumentBySlug(env, normalized);
  if (!doc) return null;
  return documentSnapshot(env, doc);
}

async function getDocumentById(env, docId) {
  const row = await env.PAGES_DB.prepare(`
    SELECT doc_id, slug, title, owner, latest_revision, created_at, updated_at
    FROM documents
    WHERE doc_id = ?
  `).bind(docId).first();
  return row ? documentSnapshot(env, formatDocumentRow(row)) : null;
}

async function selectDocumentBySlug(env, slug) {
  const row = await env.PAGES_DB.prepare(`
    SELECT doc_id, slug, title, owner, latest_revision, created_at, updated_at
    FROM documents
    WHERE slug = ?
  `).bind(slug).first();
  return row ? formatDocumentRow(row) : null;
}

async function documentSnapshot(env, doc) {
  const { results } = await env.PAGES_DB.prepare(`
    SELECT rev_id, doc_id, rev_number, status, created_at
    FROM revisions
    WHERE doc_id = ?
    ORDER BY rev_number DESC
  `).bind(doc.docId).all();
  const revisions = (results || []).map(formatRevisionRow);
  const latest = revisions.find((revision) => revision.revId === doc.latestRevision) || null;
  return {
    ...doc,
    revision: latest,
    revisions,
  };
}

async function getRevisionDocument(env, revId) {
  const row = await env.PAGES_DB.prepare(`
    SELECT
      d.doc_id,
      d.slug,
      d.title,
      d.owner,
      d.latest_revision,
      d.created_at AS doc_created_at,
      d.updated_at,
      r.rev_id,
      r.rev_number,
      r.status,
      r.created_at AS rev_created_at
    FROM revisions r
    JOIN documents d ON d.doc_id = r.doc_id
    WHERE r.rev_id = ?
  `).bind(revId).first();
  if (!row) return null;
  return {
    docId: row.doc_id,
    slug: row.slug,
    title: row.title,
    owner: row.owner,
    latestRevision: row.latest_revision,
    createdAt: row.doc_created_at,
    updatedAt: row.updated_at,
    revision: {
      revId: row.rev_id,
      docId: row.doc_id,
      revNumber: row.rev_number,
      status: row.status,
      createdAt: row.rev_created_at,
    },
  };
}

async function getRevisionBySlugNumber(env, slug, revNumber) {
  const row = await env.PAGES_DB.prepare(`
    SELECT r.rev_id, r.doc_id, r.rev_number, r.status, r.created_at
    FROM revisions r
    JOIN documents d ON d.doc_id = r.doc_id
    WHERE d.slug = ? AND r.rev_number = ?
  `).bind(normalizeSlug(slug), revNumber).first();
  return row ? formatRevisionRow(row) : null;
}

async function listDocumentsPage(env, pagination) {
  const totalRow = await env.PAGES_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM documents
    WHERE slug IS NOT NULL
  `).first();
  const pageInfo = normalizeDashboardPage({
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: Number(totalRow?.count || 0),
  });
  if (!pageInfo.totalPages) return pageInfo;

  const { results } = await env.PAGES_DB.prepare(`
    SELECT
      d.doc_id,
      d.slug,
      d.title,
      d.owner,
      d.latest_revision,
      d.created_at,
      d.updated_at,
      lr.rev_number AS latest_rev_number,
      lr.created_at AS latest_rev_created_at,
      COUNT(r.rev_id) AS revision_count
    FROM documents d
    LEFT JOIN revisions lr ON lr.rev_id = d.latest_revision
    LEFT JOIN revisions r ON r.doc_id = d.doc_id
    WHERE d.slug IS NOT NULL
    GROUP BY d.doc_id
    ORDER BY d.updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(pageInfo.pageSize, pageInfo.offset).all();
  return {
    ...pageInfo,
    items: (results || []).map((row) => ({
    docId: row.doc_id,
    slug: row.slug,
    title: row.title,
    owner: row.owner,
    latestRevision: row.latest_revision,
    latestRevNumber: row.latest_rev_number,
    latestRevCreatedAt: row.latest_rev_created_at,
    revisionCount: row.revision_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    })),
  };
}

function formatDocumentRow(row) {
  return {
    docId: row.doc_id,
    slug: row.slug,
    title: row.title,
    owner: row.owner,
    latestRevision: row.latest_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatRevisionRow(row) {
  return {
    revId: row.rev_id,
    docId: row.doc_id,
    revNumber: row.rev_number,
    status: row.status,
    createdAt: row.created_at,
  };
}

function dashboardPagination(request) {
  const url = new URL(request.url);
  const page = positiveInteger(url.searchParams.get("page")) || 1;
  const requestedPageSize = positiveInteger(url.searchParams.get("pageSize")) || DASHBOARD_DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, DASHBOARD_MAX_PAGE_SIZE);
  return { page, pageSize };
}

function normalizeDashboardPage({ page, pageSize, total, items = [] }) {
  const safeTotal = Math.max(0, Number(total || 0));
  const totalPages = safeTotal ? Math.max(1, Math.ceil(safeTotal / pageSize)) : 0;
  const normalizedPage = totalPages ? Math.min(Math.max(page, 1), totalPages) : 0;
  const offset = normalizedPage ? (normalizedPage - 1) * pageSize : 0;
  return {
    items,
    page: normalizedPage,
    pageSize,
    total: safeTotal,
    totalPages,
    offset,
  };
}

function formatDocumentResponse(documentRecord, baseUrl) {
  return {
    docId: documentRecord.docId,
    slug: documentRecord.slug,
    title: documentRecord.title,
    owner: documentRecord.owner,
    latestRevision: documentRecord.latestRevision,
    stableUrl: `${baseUrl}/d/${documentRecord.slug}`,
    createdAt: documentRecord.createdAt,
    updatedAt: documentRecord.updatedAt,
    revisions: documentRecord.revisions.map((revision) => ({
      revId: revision.revId,
      revNumber: revision.revNumber,
      status: revision.status,
      createdAt: revision.createdAt,
      pageUrl: `${baseUrl}/p/${revision.revId}`,
      revisionUrl: `${baseUrl}/d/${documentRecord.slug}/r/${revision.revNumber}`,
    })),
  };
}

async function replaceBundle(env, { revId, docId, entrypoint, files, createdAt }) {
  const manifest = buildManifest({ revId, docId, entrypoint, files, createdAt });
  for (const file of manifest.files) {
    await env.PAGES_BUCKET.put(file.bytesKey, file.bytes, {
      httpMetadata: { contentType: file.contentType },
    });
  }
  await env.PAGES_DB.prepare("DELETE FROM revision_assets WHERE rev_id = ?").bind(revId).run();
  await env.PAGES_DB.prepare("DELETE FROM revision_bundles WHERE rev_id = ?").bind(revId).run();
  await env.PAGES_DB.prepare(`
    INSERT INTO revision_bundles (rev_id, entrypoint, file_count, total_size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(revId, manifest.entrypoint, manifest.files.length, manifest.totalSizeBytes, manifest.createdAt).run();
  for (const file of manifest.files) {
    await env.PAGES_DB.prepare(`
      INSERT INTO revision_assets (rev_id, path, bytes_key, content_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(revId, file.path, file.bytesKey, file.contentType, file.sizeBytes, manifest.createdAt).run();
  }
  return formatBundle(manifest);
}

async function getAsset(env, revId, requestPath) {
  const bundle = await env.PAGES_DB.prepare(`
    SELECT rev_id, entrypoint, file_count, total_size_bytes, created_at
    FROM revision_bundles
    WHERE rev_id = ?
  `).bind(revId).first();
  if (!bundle) return null;
  const assetPath = requestPath ? normalizeBundlePath(requestPath) : bundle.entrypoint;
  const row = await env.PAGES_DB.prepare(`
    SELECT rev_id, path, bytes_key, content_type, size_bytes, created_at
    FROM revision_assets
    WHERE rev_id = ? AND path = ?
  `).bind(revId, assetPath).first();
  return row ? formatAssetRow(row) : null;
}

function buildManifest({ revId, docId, entrypoint, files, createdAt }) {
  const safeDocId = safeKeySegment(docId, "docId");
  const safeRevId = safeKeySegment(revId, "revId");
  return {
    revId,
    docId,
    entrypoint,
    files: files.map((file) => ({
      ...file,
      bytesKey: `bundles/${safeDocId}/${safeRevId}/${file.path}`,
    })),
    totalSizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    createdAt: createdAt || new Date().toISOString(),
  };
}

function formatBundle(manifest) {
  return {
    revId: manifest.revId,
    entrypoint: manifest.entrypoint,
    fileCount: manifest.files.length,
    totalSizeBytes: manifest.totalSizeBytes,
    assets: manifest.files.map((file) => ({
      path: file.path,
      bytesKey: file.bytesKey,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })),
  };
}

function formatAssetRow(row) {
  return {
    revId: row.rev_id,
    path: row.path,
    bytesKey: row.bytes_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

function normalizeUploadBundle({ html: htmlBody, files, entrypoint }) {
  if (files !== undefined && htmlBody !== undefined) throw httpError("provide either html or files, not both");
  if (files !== undefined) return normalizeFilesBundle({ files, entrypoint });
  if (!htmlBody || typeof htmlBody !== "string") throw httpError("html field is required");
  return normalizeFilesBundle({
    entrypoint: INDEX_ENTRYPOINT,
    files: [{
      path: INDEX_ENTRYPOINT,
      content: base64Encode(new TextEncoder().encode(htmlBody)),
      encoding: "base64",
      contentType: "text/html; charset=utf-8",
    }],
  });
}

function normalizeFilesBundle({ files, entrypoint }) {
  if (!Array.isArray(files) || files.length === 0) throw httpError("files must be a non-empty array");
  if (files.length > MAX_BUNDLE_FILES) throw httpError(`bundle exceeds ${MAX_BUNDLE_FILES} file limit`, 413);
  const normalizedEntrypoint = normalizeBundlePath(entrypoint || INDEX_ENTRYPOINT);
  const seen = new Set();
  let totalSizeBytes = 0;
  const normalizedFiles = files.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw httpError(`files[${index}] must be an object`);
    const assetPath = normalizeBundlePath(file.path);
    if (seen.has(assetPath)) throw httpError(`duplicate bundle path: ${assetPath}`);
    seen.add(assetPath);
    const bytes = decodeFileContent(file, index);
    totalSizeBytes += bytes.byteLength;
    if (totalSizeBytes > MAX_BUNDLE_BYTES) throw httpError(`bundle exceeds ${MAX_BUNDLE_BYTES} byte limit`, 413);
    return {
      path: assetPath,
      bytes,
      contentType: normalizeContentType(file.contentType, assetPath),
      sizeBytes: bytes.byteLength,
    };
  });
  if (!seen.has(normalizedEntrypoint)) throw httpError(`entrypoint not found in bundle: ${normalizedEntrypoint}`);
  return { entrypoint: normalizedEntrypoint, files: normalizedFiles, totalSizeBytes };
}

function decodeFileContent(file, index) {
  if (file.encoding && file.encoding !== "base64") throw httpError(`files[${index}].encoding must be base64`);
  if (typeof file.content !== "string") throw httpError(`files[${index}].content must be a base64 string`);
  const cleaned = file.content.replace(/\s/g, "");
  let bytes;
  try {
    bytes = base64Decode(cleaned);
  } catch {
    throw httpError(`files[${index}].content is not valid base64`);
  }
  if (base64Encode(bytes).replace(/=+$/, "") !== cleaned.replace(/=+$/, "")) {
    throw httpError(`files[${index}].content is not valid base64`);
  }
  return bytes;
}

function normalizeBundlePath(value) {
  if (typeof value !== "string" || !value.trim()) throw httpError("bundle path must be a non-empty string");
  if (value.length > MAX_PATH_LENGTH) throw httpError(`bundle path exceeds ${MAX_PATH_LENGTH} characters`);
  if (value.includes("\0")) throw httpError("bundle path must not contain NULL bytes");
  if (value.includes("\\")) throw httpError("bundle path must use forward slashes");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw httpError("bundle path must be relative");
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") throw httpError("bundle path must not contain empty, . or .. segments");
    if (segment.length > MAX_PATH_SEGMENT_LENGTH) throw httpError(`bundle path segment exceeds ${MAX_PATH_SEGMENT_LENGTH} characters`);
    const baseName = segment.split(".")[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(baseName)) throw httpError(`reserved bundle path segment: ${segment}`);
  }
  return segments.join("/");
}

function normalizeContentType(value, assetPath) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return inferContentType(assetPath);
}

function inferContentType(assetPath) {
  const dot = assetPath.lastIndexOf(".");
  const ext = dot === -1 ? "" : assetPath.slice(dot).toLowerCase();
  return CONTENT_TYPES.get(ext) || "application/octet-stream";
}

function withPatchedEntrypoint(bundle, patcher) {
  const files = bundle.files.map((file) => {
    if (file.path !== bundle.entrypoint) return file;
    const patched = patcher(new TextDecoder().decode(file.bytes));
    const bytes = new TextEncoder().encode(patched);
    return {
      ...file,
      bytes,
      sizeBytes: bytes.byteLength,
      contentType: normalizeContentType(file.contentType, file.path),
    };
  });
  const totalSizeBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (totalSizeBytes > MAX_BUNDLE_BYTES) throw httpError(`bundle exceeds ${MAX_BUNDLE_BYTES} byte limit`, 413);
  return { ...bundle, files, totalSizeBytes };
}

function injectReviewConfig(entryHtml, config) {
  const script = `<script>window.__PAGES_REVIEW__=${safeJson(config)};</script>`;
  if (/<\/head>/i.test(entryHtml)) return entryHtml.replace(/<\/head>/i, `${script}\n</head>`);
  return `${script}\n${entryHtml}`;
}

async function normalizeAndSaveWebhook(env, revId, webhookUrl, webhookSecret) {
  const url = normalizeWebhookUrl(webhookUrl);
  if (!url) return null;
  const secret = typeof webhookSecret === "string" ? webhookSecret : "";
  const secretHash = await saveWebhookSecret(env, revId, secret);
  return { url, secretHash };
}

function normalizeWebhookUrl(value) {
  if (!value) return "";
  if (typeof value !== "string") throw httpError("webhook URL must be a string");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError("webhook URL must be an absolute URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw httpError("webhook URL must use http or https");
  return url.toString();
}

async function saveWebhookSecret(env, revId, secret) {
  if (!secret) {
    await env.PAGES_DB.prepare("DELETE FROM webhook_secrets WHERE rev_id = ?").bind(revId).run();
    return null;
  }
  const now = new Date().toISOString();
  const secretHash = await sha256Hex(secret);
  await env.PAGES_DB.prepare(`
    INSERT INTO webhook_secrets (rev_id, secret, secret_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(rev_id) DO UPDATE SET
      secret = excluded.secret,
      secret_hash = excluded.secret_hash,
      updated_at = excluded.updated_at
  `).bind(revId, secret, secretHash, now, now).run();
  return secretHash;
}

async function getWebhookSecret(env, revId) {
  const row = await env.PAGES_DB.prepare("SELECT secret FROM webhook_secrets WHERE rev_id = ?").bind(revId).first();
  return row?.secret || "";
}

async function postAnnotationWebhook({ url, payload, secret = "", timeoutMs = WEBHOOK_TIMEOUT_MS }) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (secret) headers["X-Pages-Webhook-Signature"] = `sha256=${await hmacHex(body, secret)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!response.ok) throw new Error(`webhook returned ${response.status}`);
  } catch (err) {
    console.error("[pages-worker] annotation webhook failed", { url: redactWebhookUrl(url), error: err.message });
  } finally {
    clearTimeout(timer);
  }
}

function buildAnnotationWebhookEvent({ revId, count, timestamp = new Date().toISOString() }) {
  return {
    event: "pages.annotations.updated",
    rev_id: revId,
    count,
    annotations_url: `/api/annotations/${revId}`,
    page_url: `/p/${revId}`,
    timestamp,
  };
}

async function getCommentsPayload(env, revId) {
  const { results } = await env.PAGES_DB.prepare(`
    SELECT payload_json
    FROM comments
    WHERE rev_id = ?
    ORDER BY created_at ASC, comment_id ASC
  `).bind(revId).all();
  return {
    schema_version: "1.0",
    document_id: revId,
    comments: (results || []).map((row) => JSON.parse(row.payload_json)),
  };
}

function normalizeCommentsPayload(revId, rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new Error("request body must be a comments object");
  }
  if (!Array.isArray(rawPayload.comments)) throw new Error("comments must be an array");
  const documentId = nonEmptyString(rawPayload.document_id) || revId;
  return {
    schema_version: nonEmptyString(rawPayload.schema_version) || "1.0",
    document_id: documentId,
    comments: rawPayload.comments.map((comment, index) => normalizeComment(documentId, comment, index)),
  };
}

function normalizeComment(documentId, rawComment, index) {
  if (!rawComment || typeof rawComment !== "object" || Array.isArray(rawComment)) {
    throw new Error(`comments[${index}] must be an object`);
  }
  const id = nonEmptyString(rawComment.id);
  if (!id) throw new Error(`comments[${index}].id is required`);
  const status = STATUS_VALUES.has(rawComment.status) ? rawComment.status : "needs_agent_review";
  return {
    ...rawComment,
    id,
    document_id: nonEmptyString(rawComment.document_id) || documentId,
    block_id: stringValue(rawComment.block_id),
    selected_text: stringValue(rawComment.selected_text),
    prefix: stringValue(rawComment.prefix),
    suffix: stringValue(rawComment.suffix),
    comment: stringValue(rawComment.comment ?? rawComment.body),
    status,
    created_at: nonEmptyString(rawComment.created_at) || new Date().toISOString(),
    replies: Array.isArray(rawComment.replies) ? rawComment.replies : [],
  };
}

async function countCommentsByRevisionIds(env, revIds) {
  const unique = [...new Set(revIds.filter((revId) => typeof revId === "string" && revId))];
  const counts = Object.fromEntries(unique.map((revId) => [revId, 0]));
  if (unique.length === 0) return counts;
  const placeholders = unique.map(() => "?").join(",");
  const { results } = await env.PAGES_DB.prepare(`
    SELECT rev_id, COUNT(*) AS count
    FROM comments
    WHERE rev_id IN (${placeholders})
    GROUP BY rev_id
  `).bind(...unique).all();
  for (const row of results || []) counts[row.rev_id] = row.count;
  return counts;
}

async function startGoogleAuth(request, env) {
  const url = new URL(request.url);
  const state = newPageId() + newPageId();
  const returnTo = safeReturnTo(url.searchParams.get("returnTo") || "/");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.BASE_URL}/auth/google/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "profile email");
  authUrl.searchParams.set("state", state);
  const headers = new Headers({ Location: authUrl.toString() });
  headers.append("Set-Cookie", serializeCookie(OAUTH_STATE_COOKIE, state, { maxAge: 600 }));
  headers.append("Set-Cookie", serializeCookie(RETURN_TO_COOKIE, returnTo, { maxAge: 600 }));
  return new Response(null, { status: 302, headers });
}

async function completeGoogleAuth(request, env) {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get("cookie") || "");
  if (!url.searchParams.get("code") || url.searchParams.get("state") !== cookies[OAUTH_STATE_COOKIE]) {
    return redirect("/auth/error");
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: url.searchParams.get("code"),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.BASE_URL}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) return redirect("/auth/error");
  const token = await tokenResponse.json();
  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResponse.ok) return redirect("/auth/error");
  const profile = await profileResponse.json();
  const email = profile.email || "";
  const allowed = env.ALLOWED_EMAILS.split(",").map((item) => item.trim()).filter(Boolean);
  if (!email || !allowed.includes(email)) return redirect("/auth/error");

  const session = await signSession({
    email,
    name: profile.name || email,
    exp: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
  }, env.SESSION_SECRET);
  const headers = new Headers({ Location: cookies[RETURN_TO_COOKIE] || "/" });
  headers.append("Set-Cookie", serializeCookie(SESSION_COOKIE, session, { maxAge: 14 * 24 * 60 * 60 }));
  headers.append("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE));
  headers.append("Set-Cookie", clearCookie(RETURN_TO_COOKIE));
  return new Response(null, { status: 302, headers });
}

function logout() {
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
  headers.append("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE));
  headers.append("Set-Cookie", clearCookie(RETURN_TO_COOKIE));
  return new Response(null, { status: 302, headers });
}

async function requireAuth(request, env, options = {}) {
  const session = await getSession(request, env);
  if (session) return { session };
  if (options.json) return { response: json({ error: "Unauthorized" }, 401) };
  const url = new URL(request.url);
  return { response: redirect(`/auth/google?returnTo=${encodeURIComponent(url.pathname + url.search)}`) };
}

async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadText, signature] = parts;
  if (!safeEqual(signature, await hmacBase64Url(payloadText, env.SESSION_SECRET))) return null;
  let payload;
  try {
    payload = JSON.parse(textDecode(base64UrlDecode(payloadText)));
  } catch {
    return null;
  }
  if (!Number.isInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function signSession(payload, secret) {
  const payloadText = base64UrlEncode(textEncode(JSON.stringify(payload)));
  return `${payloadText}.${await hmacBase64Url(payloadText, secret)}`;
}

async function issueAnnotationToken({ revId, secret, ttlSeconds }) {
  if (!revId || typeof revId !== "string") throw new Error("revId is required");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = base64UrlEncode(textEncode(JSON.stringify({ typ: "pages.annotation", rev_id: revId, exp })));
  return {
    token: `${payload}.${await hmacBase64Url(payload, secret)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

async function verifyAnnotationToken(token, { revId, secret }) {
  if (!token || typeof token !== "string") return { ok: false, error: "missing_token" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "invalid_token" };
  const [payloadText, signature] = parts;
  if (!safeEqual(signature, await hmacBase64Url(payloadText, secret))) return { ok: false, error: "invalid_signature" };
  let payload;
  try {
    payload = JSON.parse(textDecode(base64UrlDecode(payloadText)));
  } catch {
    return { ok: false, error: "invalid_payload" };
  }
  if (payload.typ !== "pages.annotation" || payload.rev_id !== revId) return { ok: false, error: "wrong_scope" };
  if (!Number.isInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, error: "expired_token" };
  return { ok: true, payload };
}

function readAnnotationToken(request) {
  const headerToken = request.headers.get(ANNOTATION_TOKEN_HEADER);
  if (headerToken) return headerToken;
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Capability\s+(.+)$/i);
  return match ? match[1] : "";
}

async function readMeta(env, id) {
  if (!PAGE_ID_RE.test(id)) return null;
  const object = await env.PAGES_BUCKET.get(pageMetaKey(id));
  if (!object) return null;
  try {
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

async function writeMeta(env, id, meta) {
  await env.PAGES_BUCKET.put(pageMetaKey(id), JSON.stringify(meta, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function listAnonymousPagesPage(env, pagination) {
  const totalRow = await env.PAGES_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM documents
    WHERE slug IS NULL
      AND latest_revision IS NOT NULL
  `).first();
  const pageInfo = normalizeDashboardPage({
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: Number(totalRow?.count || 0),
  });
  if (!pageInfo.totalPages) return pageInfo;

  const { results } = await env.PAGES_DB.prepare(`
    SELECT
      d.latest_revision AS id,
      d.title,
      d.updated_at,
      COALESCE(r.created_at, d.created_at) AS created_at
    FROM documents d
    LEFT JOIN revisions r ON r.rev_id = d.latest_revision
    WHERE d.slug IS NULL
      AND d.latest_revision IS NOT NULL
    ORDER BY d.updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(pageInfo.pageSize, pageInfo.offset).all();

  const items = await Promise.all((results || []).map(async (row) => {
    const fallback = {
      id: row.id,
      title: row.title,
      createdAt: row.created_at || row.updated_at,
      private: false,
    };
    const meta = await readMeta(env, row.id);
    if (!meta) return fallback;
    return {
      ...fallback,
      title: meta.title || fallback.title,
      createdAt: meta.createdAt || fallback.createdAt,
      private: meta.private === true,
    };
  }));
  return { ...pageInfo, items };
}

function pageMetaKey(id) {
  return `pages/${id}.json`;
}

function pageHtmlKey(id) {
  return `pages/${id}.html`;
}

function renderDashboard({ pages, documents = [], baseUrl }) {
  const documentPage = normalizeDashboardCollection(documents, DASHBOARD_DEFAULT_PAGE_SIZE);
  const pagePage = normalizeDashboardCollection(pages, DASHBOARD_DEFAULT_PAGE_SIZE);
  const documentRows = documentPage.items.map((documentRecord) => renderDocumentRow(documentRecord)).join("");
  const pageRows = pagePage.items.map((page) => renderPageRow(page, baseUrl)).join("");

  return renderLayout({
    title: "Pages 대시보드",
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
      kind: "documents",
      title: "문서",
      subtitle: "고정 URL과 리비전을 가진 장기 문서",
      page: documentPage,
      rows: documentRows,
      emptyLabel: "문서가 없습니다",
    })}

    ${renderDashboardSection({
      kind: "pages",
      title: "단발 게시",
      subtitle: "일회성 HTML 공유 페이지",
      page: pagePage,
      rows: pageRows,
      emptyLabel: "단발 게시가 없습니다",
    })}
  </main>
  ${jsonScript("dashboard-documents-data", documentPage)}
  ${jsonScript("dashboard-pages-data", pagePage)}
  ${dashboardScript(baseUrl)}`,
  });
}

function renderDashboardSection({ kind, title, subtitle, page, rows, emptyLabel }) {
  const hasItems = page.items.length > 0;
  return `
    <section class="dashboard-section" data-section="${escAttr(kind)}" data-endpoint="/api/dashboard/${kind === "documents" ? "documents" : "pages"}">
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
  const pageLabel = page.totalPages ? `${page.page} / ${page.totalPages}` : "0 / 0";
  const prevDisabled = page.page <= 1 ? " disabled" : "";
  const nextDisabled = !page.totalPages || page.page >= page.totalPages ? " disabled" : "";
  return `
        <nav class="pagination" aria-label="페이지 이동">
          <button class="button secondary" type="button" data-page-action="prev"${prevDisabled}>이전</button>
          <span class="page-label" data-page-label>${escHtml(pageLabel)}</span>
          <button class="button secondary" type="button" data-page-action="next"${nextDisabled}>다음</button>
        </nav>`;
}

function renderDocumentDetail({ documentRecord, revisions, baseUrl }) {
  const stableUrl = `${baseUrl}/d/${documentRecord.slug}`;
  const revisionRows = revisions.map((revision) => renderRevisionRow(documentRecord, revision, baseUrl)).join("");
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
          <tbody>${revisionRows || emptyRow(6, "리비전이 없습니다")}</tbody>
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
    : "-";
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
  const visLabel = page.private ? "비공개" : "공개";
  const toggleLabel = page.private ? "공개로 전환" : "비공개로 전환";
  const toggleValue = page.private ? "false" : "true";
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
  const commentList = comments.map(renderComment).join("");
  const reviewLabel = revision.reviewable ? "reviewable" : "-";
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
  const author = comment.author || "reviewer";
  const body = comment.comment || comment.body || "";
  const selectedText = comment.selected_text || comment.anchor?.selected_text || "";
  const status = comment.resolved === true || comment.status === "resolved" ? "resolved" : (comment.status || "open");
  return `
              <article class="comment">
                <p>${escHtml(body)}</p>
                <dl class="comment-meta">
                  <div><dt>Author</dt><dd>${escHtml(author)}</dd></div>
                  <div><dt>Anchor</dt><dd>${escHtml(selectedText || "-")}</dd></div>
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
        if (!el) return { items: [], page: 0, pageSize: ${DASHBOARD_DEFAULT_PAGE_SIZE}, total: 0, totalPages: 0 };
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

function normalizeDashboardCollection(value, fallbackPageSize) {
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

function jsonScript(id, value) {
  const body = JSON.stringify(value).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${escAttr(id)}">${body}</script>`;
}

function escJsTemplate(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function objectResponse(object, fallbackType) {
  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || fallbackType);
  if (object.size !== undefined) headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "no-store");
  return new Response(object.body, { headers });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function notFound() {
  return html("<h1>404 Not Found</h1>", 404);
}

function hasBearerToken(request, token) {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    cookies[name] = decodeURIComponent(rest.join("=") || "");
  }
  return cookies;
}

function serializeCookie(name, value, { maxAge } = {}) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (maxAge !== undefined) attrs.push(`Max-Age=${maxAge}`);
  return attrs.join("; ");
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function safeReturnTo(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function isValidDocumentSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeSlug(slug) {
  if (typeof slug !== "string") throw new Error("doc slug must be a string");
  if (!SLUG_RE.test(slug)) throw new Error("doc slug must match ^[a-z0-9][a-z0-9_-]{2,63}$");
  if (RESERVED_SLUGS.has(slug)) throw new Error(`reserved doc slug: ${slug}`);
  return slug;
}

function titleValue(title) {
  return nonEmptyString(title) || "(제목 없음)";
}

function ownerValue(owner) {
  return nonEmptyString(owner) || DEFAULT_OWNER;
}

function newPageId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function newDocId() {
  return `doc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function anonymousDocId(revId) {
  return `anon_${revId}`;
}

function safeKeySegment(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw httpError(`${name} is not safe for bundle storage`);
  return value;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function formatDate(value) {
  return value || "-";
}

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(value) {
  return escHtml(value).replace(/'/g, "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function redactWebhookUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?redacted";
    return url.toString();
  } catch {
    return "<invalid webhook url>";
  }
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function textEncode(value) {
  return new TextEncoder().encode(value);
}

function textDecode(value) {
  return new TextDecoder().decode(value);
}

function base64Encode(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64Decode(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64Decode(padded);
}

async function hmacBase64Url(body, secret) {
  return base64UrlEncode(await hmacBytes(body, secret));
}

async function hmacHex(body, secret) {
  return bytesToHex(await hmacBytes(body, secret));
}

async function hmacBytes(body, secret) {
  const key = await crypto.subtle.importKey("raw", textEncode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncode(body)));
}

async function sha256Hex(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncode(value))));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
