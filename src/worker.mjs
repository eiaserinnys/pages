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
    const target = `/d/${slug}/r/${documentRecord.revision.revNumber}${url.pathname.endsWith("/") ? "/" : ""}${url.search}`;
    return redirect(target);
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
  await env.PAGES_BUCKET.delete(pageMetaKey(pageId));
  await env.PAGES_BUCKET.delete(pageHtmlKey(pageId));
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
  const pages = (await listMetas(env)).filter((page) => !page.document?.slug);
  pages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const documents = await listDocuments(env);
  return html(renderDashboard({ pages, documents, baseUrl: env.BASE_URL }));
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
  return html(renderDocumentDetail({ documentRecord, revisions, baseUrl: env.BASE_URL }));
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

async function listDocuments(env) {
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
  `).all();
  return (results || []).map((row) => ({
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
  }));
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

async function listMetas(env) {
  const pages = [];
  let cursor = undefined;
  do {
    const listed = await env.PAGES_BUCKET.list({ prefix: "pages/", cursor });
    for (const object of listed.objects) {
      if (!object.key.endsWith(".json")) continue;
      const page = await env.PAGES_BUCKET.get(object.key);
      if (!page) continue;
      try {
        pages.push(JSON.parse(await page.text()));
      } catch {
        // Ignore broken metadata.
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return pages;
}

function pageMetaKey(id) {
  return `pages/${id}.json`;
}

function pageHtmlKey(id) {
  return `pages/${id}.html`;
}

function renderDashboard({ pages, documents = [], baseUrl }) {
  const documentRows = documents.map((documentRecord) => renderDocumentRow(documentRecord)).join("");
  const pageRows = pages.map((page) => renderPageRow(page, baseUrl)).join("");
  return renderLayout({
    title: "Pages 대시보드",
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
      <tbody>${documentRows || emptyRow(6, "문서가 없습니다")}</tbody>
    </table>
  </section>

  <section>
    <h2>익명 페이지</h2>
    <table>
      <thead>
        <tr><th>제목</th><th>공개 여부</th><th>생성일</th><th>관리</th></tr>
      </thead>
      <tbody>${pageRows || emptyRow(4, "페이지가 없습니다")}</tbody>
    </table>
  </section>
  ${managementScript()}`,
  });
}

function renderDocumentDetail({ documentRecord, revisions, baseUrl }) {
  const stableUrl = `${baseUrl}/d/${documentRecord.slug}`;
  const revisionRows = revisions.map((revision) => renderRevisionRow(documentRecord, revision, baseUrl)).join("");
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
      <tbody>${revisionRows || emptyRow(6, "리비전이 없습니다")}</tbody>
    </table>
  </section>`,
  });
}

function renderDocumentRow(documentRecord) {
  const detailUrl = `/dashboard/documents/${encodeURIComponent(documentRecord.slug)}`;
  const latestLabel = documentRecord.latestRevNumber
    ? `r${documentRecord.latestRevNumber} | ${formatDate(documentRecord.latestRevCreatedAt)}`
    : "-";
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
  const visLabel = page.private ? "비공개" : "공개";
  const toggleLabel = page.private ? "공개로 전환" : "비공개로 전환";
  const toggleValue = page.private ? "false" : "true";
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
  const commentList = comments.map(renderComment).join("");
  const reviewLabel = revision.reviewable ? "reviewable" : "-";
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

function escJsString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
