import { reviewClientSource } from './reviewClient.mjs';
import dashboardModule from './dashboard.js';
import { createVtuberLiveSession } from './vtuberLive.mjs';
import { hmacBase64Url, base64Decode, base64Encode, base64UrlDecode, base64UrlEncode, safeEqual, textDecode, textEncode } from './signedTokens.mjs';
import {
  authorizeOAuthClient,
  exchangeOAuthToken,
  oauthDiscovery,
  registerOAuthClient,
  verifyOAuthAccessToken,
  verifyViewToken,
} from './oauthProvider.mjs';
import { getDocState, parseDocStateMarker, putDocState, registerDocState } from './docState.mjs';
import {
  dashboardQuery as readDashboardQuery,
  deleteDashboardPageData,
  getDashboardDocumentDetail,
  getDashboardPageDetail,
  listDashboardDocuments,
  listDashboardPages,
  setDashboardDocumentVisibility,
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
const CHANGE_EVENT_STREAM_NAME = "pages";
const CHANGE_EVENT_KEEPALIVE_MS = 30 * 1000;
const CHANGE_EVENT_TYPES = new Set(["document_updated", "page_updated"]);
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
    const headOnly = request.method === "HEAD";
    try {
      assertRequiredEnv(env);
      const routedRequest = headOnly ? new Request(request, { method: "GET" }) : request;
      const response = await routeRequest(routedRequest, env, ctx);
      return headOnly ? withoutBody(response) : response;
    } catch (err) {
      console.error("[pages-worker] request failed", err);
      const response = json({ error: "Internal server error" }, 500);
      return headOnly ? withoutBody(response) : response;
    }
  },
};

function withoutBody(response) {
  response.body?.cancel().catch(() => {});
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/.well-known/oauth-authorization-server") return oauthDiscovery(env);
  if (request.method === "POST" && pathname === "/auth/oauth/register") return registerOAuthClient(request, env);
  if (request.method === "GET" && pathname === "/auth/oauth/authorize") {
    return authorizeOAuthClient(request, env, getSession);
  }
  if (request.method === "POST" && pathname === "/auth/oauth/token") return exchangeOAuthToken(request, env);

  if (request.method === 'POST' && pathname === '/api/vtuber-live/session') {
    return createVtuberLiveSession(request, env, await getSession(request, env));
  }

  if (request.method === "GET" && pathname === "/auth/google") return startGoogleAuth(request, env);
  if (request.method === "GET" && pathname === "/auth/google/callback") return completeGoogleAuth(request, env);
  if (request.method === "GET" && pathname === "/auth/logout") return logout();
  if (request.method === "GET" && pathname === "/auth/error") {
    return html("<h1>403 Forbidden</h1><p>Access denied. Your Google account is not authorized.</p>", 403);
  }

  if (request.method === "POST" && pathname === "/api/pages") return uploadPage(request, env, ctx);

  if (request.method === "GET" && pathname.startsWith("/v/")) return serveViewRoute(request, env);

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

  if (request.method === "GET" && pathname === "/api/events") {
    const auth = await requireAuth(request, env, { json: true });
    if (auth.response) return auth.response;
    return openChangeEventStream(env);
  }

  const dashboardDocumentVisibilityMatch = pathname.match(/^\/api\/dashboard\/documents\/([^/]+)\/visibility$/);
  if (request.method === "PATCH" && dashboardDocumentVisibilityMatch) {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    const slug = safeDecodeURIComponent(dashboardDocumentVisibilityMatch[1]);
    if (!isValidDocumentSlug(slug)) return json({ error: "Not found" }, 404);
    return updateDocumentVisibility(request, env, ctx, slug);
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

  const documentStateMatch = pathname.match(/^\/api\/documents\/([^/]+)\/state$/);
  if (documentStateMatch) return documentStateApi(request, env, safeDecodeURIComponent(documentStateMatch[1]));

  const documentApiMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (request.method === "GET" && documentApiMatch) {
    return getDocumentApi(request, env, decodeURIComponent(documentApiMatch[1]));
  }

  const annotationMatch = pathname.match(/^\/api\/annotations\/([0-9a-f]{12})$/);
  if (annotationMatch && request.method === "GET") return listAnnotations(request, env, annotationMatch[1]);
  if (annotationMatch && request.method === "PUT") return replaceAnnotations(request, env, ctx, annotationMatch[1]);

  if (annotationMatch && request.method === "POST") return appendAnnotation(request, env, ctx, annotationMatch[1]);

  const replyMatch = pathname.match(/^\/api\/annotations\/([0-9a-f]{12})\/([^/]+)\/replies$/);
  if (replyMatch && request.method === "POST") {
    const commentId = safeDecodeURIComponent(replyMatch[2]);
    if (!commentId) return json({ error: "Not found" }, 404);
    return appendAnnotationReply(request, env, ctx, replyMatch[1], commentId);
  }

  const visibilityMatch = pathname.match(/^\/api\/pages\/([0-9a-f]{12})\/visibility$/);
  if (visibilityMatch && request.method === "PATCH") {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    return updateVisibility(request, env, ctx, visibilityMatch[1]);
  }

  const deleteMatch = pathname.match(/^\/api\/pages\/([0-9a-f]{12})$/);
  if (deleteMatch && request.method === "DELETE") {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
    return deletePage(env, ctx, deleteMatch[1]);
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

export function assertRequiredEnv(env) {
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

async function uploadPage(request, env, ctx) {
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

  const reviewPathsError = validateReviewPathsField(body);
  if (reviewPathsError) return json({ error: reviewPathsError }, 400);

  let bundle;
  try {
    bundle = normalizeUploadBundle(body);
  } catch (err) {
    return json({ error: err.message }, err.statusCode || 400);
  }

  let reviewPaths;
  try {
    reviewPaths = normalizeReviewPaths(body.reviewPaths, bundle);
  } catch (err) {
    return json({ error: err.message }, err.statusCode || 400);
  }

  const validationError = validateUploadOptions(body);
  if (validationError) return json({ error: validationError }, 400);

  let docStateConfig = null;
  if (body.doc) {
    try {
      docStateConfig = parseDocStateMarker(bundle.files.find((file) => file.path === bundle.entrypoint).bytes);
    } catch (err) {
      return json({ error: err.message }, err.statusCode || 400);
    }
  }

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
      if (!reviewPaths || reviewPaths.includes(bundle.entrypoint)) {
        bundle = withPatchedEntrypoint(bundle, (entryHtml) => injectReviewConfig(entryHtml, review));
      }
      webhook = await normalizeAndSaveWebhook(env, id, body.webhookUrl, body.webhookSecret);
    } catch (err) {
      return json({ error: err.message }, err.statusCode || 400);
    }
  }

  let documentRecord;
  let isPrivate = body.private === true;
  try {
    if (body.doc && typeof body.private !== "boolean") {
      const existingDocument = await getDocument(env, body.doc);
      const latestMeta = existingDocument?.latestRevision ? await readMeta(env, existingDocument.latestRevision) : null;
      isPrivate = latestMeta?.private === true;
    }
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

  if (docStateConfig) await registerDocState(env, revisionDocument.docId, docStateConfig, createdAt);

  const meta = buildPageMeta({
    id,
    title,
    createdAt,
    isPrivate,
    documentRecord,
    review,
    reviewPaths,
    webhook,
    manifest,
  });
  await writeMeta(env, id, meta);

  const entrypointFile = bundle.files.find((file) => file.path === bundle.entrypoint);
  await env.PAGES_BUCKET.put(pageHtmlKey(id), entrypointFile.bytes, {
    httpMetadata: { contentType: entrypointFile.contentType },
  });

  if (documentRecord?.slug) notifyChange(env, ctx, "document_updated", documentRecord.slug);
  else notifyChange(env, ctx, "page_updated", id);
  return json(buildUploadResponse({ id, baseUrl: env.BASE_URL, documentRecord, review, isPrivate }), 201);
}

function validateUploadOptions({ reviewable, webhookUrl, webhookSecret, doc, owner }) {
  if (reviewable !== true && (webhookUrl || webhookSecret)) return "webhook requires reviewable=true";
  if (webhookSecret !== undefined && typeof webhookSecret !== "string") return "webhookSecret must be a string";
  if (webhookSecret && !webhookUrl) return "webhookSecret requires webhookUrl";
  if (doc !== undefined && doc !== null && typeof doc !== "string") return "doc must be a string";
  if (owner !== undefined && owner !== null && typeof owner !== "string") return "owner must be a string";
  return "";
}

function validateReviewPathsField(body) {
  if (body === null) return "";
  if (!Object.hasOwn(body, "reviewPaths")) return "";
  if (body.reviewable !== true) return "reviewPaths requires reviewable=true";
  if (!Array.isArray(body.reviewPaths) || body.reviewPaths.length === 0 || body.reviewPaths.some((path) => typeof path !== "string")) {
    return "reviewPaths must be a non-empty array of bundle paths";
  }
  return "";
}

function normalizeReviewPaths(paths, bundle) {
  if (paths === undefined) return undefined;
  const normalized = [];
  const seen = new Set();
  for (const rawPath of paths) {
    const assetPath = normalizeBundlePath(rawPath);
    const file = bundle.files.find((candidate) => candidate.path === assetPath);
    if (!file) throw httpError(`reviewPaths entry not found in bundle: ${assetPath}`);
    if (!/^text\/html(?:;|$)/i.test(file.contentType)) {
      throw httpError(`reviewPaths entry is not HTML: ${assetPath}`);
    }
    if (!seen.has(assetPath)) {
      seen.add(assetPath);
      normalized.push(assetPath);
    }
  }
  return normalized;
}

function buildPageMeta({ id, title, createdAt, isPrivate, documentRecord, review, reviewPaths, webhook, manifest }) {
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
    if (reviewPaths !== undefined) meta.reviewPaths = reviewPaths;
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

function buildUploadResponse({ id, baseUrl, documentRecord, review, isPrivate }) {
  const response = { id, url: `${baseUrl}/p/${id}`, private: isPrivate };
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

async function serveViewRoute(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v\/([^/]+)(?:\/(.*))?$/);
  if (!match) return withPrivateViewHeaders(notFound());
  const [, token, assetPath] = match;
  const view = await verifyViewToken(token, env);
  if (!view) return withPrivateViewHeaders(notFound());
  if (view.expired) {
    return withPrivateViewHeaders(html("<h1>열람 링크가 만료되었습니다</h1><p>새 열람 링크로 다시 여십시오.</p>", 410));
  }
  if (assetPath === undefined) return withPrivateViewHeaders(redirect(`/v/${token}/${url.search}`));
  return withPrivateViewHeaders(await sendPageAsset(request, env, view.rev, assetPath, true));
}

function withPrivateViewHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
  const latestRevId = await getLatestRevisionId(env, slug);
  if (!latestRevId) return notFound();
  if (latestAsset[2] === undefined) {
    return redirect(`${url.origin}/d/${slug}/${url.search}`);
  }
  return sendPageAsset(request, env, latestRevId, latestAsset[2] || "");
}

async function sendPageAsset(request, env, pageId, assetPath = "", skipPrivateAuth = false) {
  // The asset lookup runs beside the meta read; its result is only used after the meta and privacy checks.
  const [meta, assetResult] = await Promise.all([
    readMeta(env, pageId),
    getAsset(env, pageId, assetPath).then((asset) => ({ asset }), () => ({ failed: true })),
  ]);
  if (!meta) return notFound();
  if (meta.private && !skipPrivateAuth) {
    const auth = await requireAuth(request, env);
    if (auth.response) return auth.response;
  }
  if (assetResult.failed) return notFound();
  const { asset } = assetResult;

  if (!asset && assetPath) return notFound();
  if (!asset) {
    const object = await env.PAGES_BUCKET.get(pageHtmlKey(pageId));
    if (!object) return notFound();
    return reviewPageResponse(object, "text/html; charset=utf-8", meta, env);
  }

  const object = await env.PAGES_BUCKET.get(asset.bytesKey);
  if (!object) return notFound();
  return reviewPageResponse(object, asset.contentType, meta, env, asset.path, asset.isEntrypoint);
}

async function reviewPageResponse(object, contentType, meta, env, assetPath = "index.html", isEntrypoint = true) {
  if (!meta.reviewable || !/^text\/html(?:;|$)/i.test(contentType)
    || (Array.isArray(meta.reviewPaths) && !meta.reviewPaths.includes(assetPath))) {
    return objectResponse(object, contentType);
  }
  const issued = await issueAnnotationToken({ revId: meta.id, secret: env.SESSION_SECRET, ttlSeconds: ANNOTATION_TOKEN_TTL_SECONDS });
  const config = { revId: meta.id, assetPath, isEntrypoint, annotationsUrl: `/api/annotations/${meta.id}`,
    tokenHeader: ANNOTATION_TOKEN_HEADER, capabilityToken: issued.token, expiresAt: issued.expiresAt };
  // Refresh legacy upload-time tokens without changing stored revisions or their content.
  const source = (await object.text()).replace(/<script>window\.__PAGES_REVIEW__=[\s\S]*?<\/script>/g, '');
  const boot = `<script>window.__PAGES_REVIEW__=${safeJson(config)};${reviewClientSource}</script>`;
  const body = /<\/body>/i.test(source) ? source.replace(/<\/body>/i, () => `${boot}\n</body>`) : `${source}\n${boot}`;
  const response = html(body);
  response.headers.set("Content-Length", String(textEncode(body).byteLength));
  return response;
}

// Private documents require a signed-in session; returns a Response to send, or null when readable.
async function documentReadDenied(request, env, documentRecord) {
  const latestMeta = documentRecord.latestRevision ? await readMeta(env, documentRecord.latestRevision) : null;
  if (!latestMeta?.private) return null;
  const auth = await requireAuth(request, env, { json: true });
  return auth.response || null;
}

async function getDocumentApi(request, env, slug) {
  if (!isValidDocumentSlug(slug)) return json({ error: "Not found" }, 404);
  const doc = await selectDocumentBySlug(env, normalizeSlug(slug));
  if (!doc) return json({ error: "Not found" }, 404);
  const [documentRecord, denied] = await Promise.all([
    documentSnapshot(env, doc),
    documentReadDenied(request, env, doc),
  ]);
  if (denied) return denied;
  return json(formatDocumentResponse(documentRecord, env.BASE_URL));
}

async function documentStateApi(request, env, slug) {
  if (request.method !== "GET" && request.method !== "PUT") {
    const response = json({ error: "method_not_allowed" }, 405);
    response.headers.set("Allow", "GET, PUT");
    return response;
  }
  if (!isValidDocumentSlug(slug)) return json({ error: "document_not_found" }, 404);
  const documentRecord = await getDocument(env, slug);
  if (!documentRecord) return json({ error: "document_not_found" }, 404);
  const denied = await documentReadDenied(request, env, documentRecord);
  if (denied) return denied;
  const result = request.method === "GET"
    ? await getDocState(env, documentRecord.docId)
    : await putDocState(request, env, documentRecord.docId);
  return json(result.body, result.status);
}

async function updateVisibility(request, env, ctx, pageId) {
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
  notifyChange(env, ctx, "page_updated", pageId);
  return json({ id: pageId, private: meta.private });
}

async function updateDocumentVisibility(request, env, ctx, slug) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }
  if (typeof body.private !== "boolean") return json({ error: "private field must be boolean" }, 400);
  const result = await setDashboardDocumentVisibility(env, slug, body.private);
  if (result.status === "not_found") return json({ error: "Not found" }, 404);
  if (result.status === "invalid_metadata") {
    return json({
      error: "Document visibility requires valid metadata for every revision",
      invalidRevisionIds: result.invalidRevisionIds,
    }, 409);
  }
  const { status: _status, ...payload } = result;
  notifyChange(env, ctx, "document_updated", slug);
  return json(payload);
}

async function deletePage(env, ctx, pageId) {
  const meta = await readMeta(env, pageId);
  if (!meta) return json({ error: "Not found" }, 404);
  const deleted = await deleteDashboardPageData(env, pageId);
  await env.PAGES_BUCKET.delete([
    pageMetaKey(pageId),
    pageHtmlKey(pageId),
    ...deleted.assetKeys,
  ]);
  notifyChange(env, ctx, "page_updated", pageId);
  return new Response(null, { status: 204 });
}

async function annotationAccess(request, env, revId, write = false) {
  const meta = await readMeta(env, revId);
  if (!meta || meta.reviewable !== true) return { response: json({ error: "Not found" }, 404) };
  if (meta.private) {
    const capability = await verifyAnnotationToken(readAnnotationToken(request), { revId, secret: env.SESSION_SECRET });
    if (!capability.ok) {
      const auth = await requireAuth(request, env, { json: true });
      if (auth.response) return auth;
    }
  }
  if (write) {
    const result = await verifyAnnotationToken(readAnnotationToken(request), { revId, secret: env.SESSION_SECRET });
    if (!result.ok) return { response: json({ error: "Unauthorized", reason: result.error }, 401) };
  }
  return { meta };
}

async function listAnnotations(request, env, revId) {
  const access = await annotationAccess(request, env, revId);
  return access.response || json(await getCommentsPayload(env, revId));
}

function newAnnotationText(raw) {
  if (!raw || typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(raw.id)
    || typeof raw.comment !== 'string' || !raw.comment.trim() || raw.comment.length > 10000
    || (raw.author !== undefined && (typeof raw.author !== 'string' || raw.author.length > 100))) {
    throw new Error('Invalid comment');
  }
  return { id: raw.id, comment: raw.comment.trim(), author: raw.author?.trim() || '익명' };
}

function newAnnotationAnchor(raw) {
  for (const [key, limit] of Object.entries({selected_text:2000,block_id:512,prefix:64,suffix:64,asset_path:512})) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > limit)) throw new Error('Invalid anchor');
  }
  const position = raw.text_position;
  if (position !== undefined && (!position || !Number.isSafeInteger(position.start) || !Number.isSafeInteger(position.end)
    || position.start < 0 || position.end <= position.start || position.end - position.start !== (raw.selected_text || '').length)) {
    throw new Error('Invalid text position');
  }
  return { selected_text:raw.selected_text || '', block_id:raw.block_id || '', prefix:raw.prefix || '', suffix:raw.suffix || '',
    asset_path:raw.asset_path ? normalizeBundlePath(raw.asset_path) : '',
    ...(position ? {text_position:{start:position.start,end:position.end}} : {}) };
}

function annotationAnchor(comment) {
  return { document_id:comment.document_id, block_id:comment.block_id, selected_text:comment.selected_text,
    prefix:comment.prefix, suffix:comment.suffix, asset_path:comment.asset_path || '',
    ...(comment.text_position ? {text_position:comment.text_position} : {}) };
}

function sameAnnotationText(left, right) {
  return left?.comment === right.comment && left?.author === right.author;
}

function notifyAnnotation(env, ctx, meta, revId) {
  if (!meta.review?.webhookUrl) return;
  ctx.waitUntil((async () => {
    const secret = await getWebhookSecret(env, revId);
    const count = (await getCommentsPayload(env, revId)).comments.length;
    await postAnnotationWebhook({url:meta.review.webhookUrl,payload:buildAnnotationWebhookEvent({revId,count}),secret});
  })().catch(error => console.error('[pages-worker] annotation webhook failed', error)));
}

async function appendAnnotation(request, env, ctx, revId) {
  const access = await annotationAccess(request, env, revId, true);
  if (access.response) return access.response;
  let comment;
  try {
    const raw = await request.json();
    comment = normalizeComment(revId, {...newAnnotationText(raw),...newAnnotationAnchor(raw)},0);
  } catch (error) { return json({error:error.message},400); }
  const result = await env.PAGES_DB.prepare(`INSERT INTO comments
    (comment_id, rev_id, anchor, body, author, created_at, resolved, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(comment_id) DO NOTHING`).bind(
    comment.id,revId,JSON.stringify(annotationAnchor(comment)),comment.comment,comment.author,
    comment.created_at,JSON.stringify(comment),comment.created_at).run();
  if (!result.meta.changes) {
    const existing = await env.PAGES_DB.prepare('SELECT rev_id, payload_json FROM comments WHERE comment_id = ?').bind(comment.id).first();
    const saved = existing && JSON.parse(existing.payload_json);
    if (existing?.rev_id !== revId || !sameAnnotationText(saved,comment)
      || JSON.stringify(annotationAnchor(saved)) !== JSON.stringify(annotationAnchor(comment))) {
      return json({error:'Comment ID already used'},409);
    }
    return json({ok:true,revId,id:comment.id});
  }
  notifyAnnotation(env,ctx,access.meta,revId);
  notifyRevisionChange(env, ctx, access.meta, revId);
  return json({ok:true,revId,id:comment.id},201);
}

async function appendAnnotationReply(request, env, ctx, revId, commentId) {
  const access = await annotationAccess(request,env,revId,true);
  if (access.response) return access.response;
  let reply;
  try { reply = {...newAnnotationText(await request.json()),created_at:new Date().toISOString()}; }
  catch(error) { return json({error:error.message},400); }
  // One atomic JSON append: concurrent replies never read and replace the thread.
  const result = await env.PAGES_DB.prepare(`UPDATE comments SET
    payload_json = json_set(payload_json, '$.replies', json_insert(
      CASE WHEN json_type(payload_json,'$.replies') = 'array' THEN json_extract(payload_json,'$.replies') ELSE '[]' END,
      '$[#]', json(?))), updated_at = ?
    WHERE rev_id = ? AND comment_id = ? AND NOT EXISTS (
      SELECT 1 FROM json_each(payload_json,'$.replies')
      WHERE CASE WHEN type = 'object' THEN json_extract(value,'$.id') END = ?
    )`).bind(JSON.stringify(reply),reply.created_at,revId,commentId,reply.id).run();
  if (!result.meta.changes) {
    const row = await env.PAGES_DB.prepare('SELECT payload_json FROM comments WHERE rev_id = ? AND comment_id = ?').bind(revId,commentId).first();
    if (!row) return json({error:'Not found'},404);
    const saved = (JSON.parse(row.payload_json).replies || []).find(item => item?.id === reply.id);
    if (!sameAnnotationText(saved,reply)) return json({error:'Reply ID already used'},409);
    return json({ok:true,revId,id:reply.id,commentId});
  }
  notifyAnnotation(env,ctx,access.meta,revId);
  notifyRevisionChange(env, ctx, access.meta, revId);
  return json({ok:true,revId,id:reply.id,commentId},201);
}

async function replaceAnnotations(request, env, ctx, revId) {
  const access = await annotationAccess(request,env,revId,true);
  if (access.response) return access.response;
  const {meta} = access;

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
    const anchor = annotationAnchor(comment);
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
  notifyRevisionChange(env, ctx, meta, revId);
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

async function getLatestRevisionId(env, slug) {
  const row = await env.PAGES_DB.prepare(`
    SELECT r.rev_id
    FROM documents d
    JOIN revisions r ON r.rev_id = d.latest_revision AND r.doc_id = d.doc_id
    WHERE d.slug = ?
  `).bind(normalizeSlug(slug)).first();
  return row ? row.rev_id : null;
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
  const assetPath = requestPath ? normalizeBundlePath(requestPath) : null;
  const row = await env.PAGES_DB.prepare(`
    SELECT b.entrypoint, a.rev_id, a.path, a.bytes_key, a.content_type, a.size_bytes, a.created_at
    FROM revision_bundles b
    LEFT JOIN revision_assets a ON a.rev_id = b.rev_id AND a.path = COALESCE(?, b.entrypoint)
    WHERE b.rev_id = ?
  `).bind(assetPath, revId).first();
  if (!row?.path) return null;
  return { ...formatAssetRow(row), isEntrypoint: row.path === row.entrypoint };
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
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer(?:\s+(.*))?$/i);
  if (bearer) {
    const session = await verifyOAuthAccessToken((bearer[1] || "").trim(), env);
    if (session) return { session };
    const response = json({ error: "invalid_token" }, 401);
    response.headers.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    return { response };
  }
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
  if (payload.typ !== undefined) return null;
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

function pageMetaKey(id) {
  return `pages/${id}.json`;
}

function pageHtmlKey(id) {
  return `pages/${id}.html`;
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

async function openChangeEventStream(env) {
  const events = env.PAGES_EVENTS;
  if (!events) return json({ error: "Change events are not configured" }, 503);
  const stub = events.get(events.idFromName(CHANGE_EVENT_STREAM_NAME));
  return stub.fetch("https://pages-events.internal/stream");
}

function notifyChange(env, ctx, type, id) {
  const events = env.PAGES_EVENTS;
  if (!events || typeof ctx?.waitUntil !== "function") return;
  ctx.waitUntil((async () => {
    const stub = events.get(events.idFromName(CHANGE_EVENT_STREAM_NAME));
    await stub.fetch("https://pages-events.internal/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id }),
    });
  })().catch((error) => console.error("[pages-worker] change notification failed", error)));
}

function notifyRevisionChange(env, ctx, meta, revId) {
  const slug = meta?.document?.slug;
  if (slug) notifyChange(env, ctx, "document_updated", slug);
  else notifyChange(env, ctx, "page_updated", revId);
}

export class PagesEvents {
  constructor() {
    this.clients = new Set();
    this.keepaliveTimer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/stream") return this.openStream();
    if (request.method === "POST" && url.pathname === "/notify") return this.publish(request);
    return new Response(null, { status: 404 });
  }

  openStream() {
    const encoder = new TextEncoder();
    let client;
    const stream = new ReadableStream({
      start: (controller) => {
        client = { controller, encoder };
        this.clients.add(client);
        this.startKeepalive();
      },
      cancel: () => {
        this.clients.delete(client);
        this.stopKeepaliveWhenIdle();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  async publish(request) {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!payload || !CHANGE_EVENT_TYPES.has(payload.type) || typeof payload.id !== "string" || !payload.id) {
      return new Response(null, { status: 400 });
    }
    this.broadcast(`event: ${payload.type}\ndata: ${JSON.stringify({ type: payload.type, id: payload.id })}\n\n`);
    return new Response(null, { status: 204 });
  }

  broadcast(frame) {
    const bytes = new TextEncoder().encode(frame);
    for (const client of [...this.clients]) {
      try {
        client.controller.enqueue(bytes);
      } catch {
        this.clients.delete(client);
      }
    }
    this.stopKeepaliveWhenIdle();
  }

  startKeepalive() {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => this.broadcast(": keepalive\n\n"), CHANGE_EVENT_KEEPALIVE_MS);
  }

  stopKeepaliveWhenIdle() {
    if (this.clients.size || !this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}
