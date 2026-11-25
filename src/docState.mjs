import { base64UrlDecode, base64UrlEncode, safeEqual, textDecode } from './signedTokens.mjs';

const MARKER_ID = 'pages-doc-state';
const MAX_STATE_BODY_BYTES = 1024 * 1024;
const MIN_ITER = 10000;
const MAX_ITER = 1000000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

class DocStateMarkerError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

function base64ByteLength(value) {
  if (typeof value !== 'string' || !BASE64_RE.test(value) || value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    return binary.length;
  } catch {
    return null;
  }
}

function decodedBase64UrlLength(value) {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null;
  try {
    return base64UrlDecode(value).length;
  } catch {
    return null;
  }
}

function readMarkerText(html) {
  if (!html.includes(MARKER_ID)) return null;
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = scriptRe.exec(html))) {
    if (new RegExp(`\\bid\\s*=\\s*["']${MARKER_ID}["']`, 'i').test(match[1])) return match[2];
  }
  return null;
}

// Returns null when the entry HTML has no marker, a validated config when it does,
// and throws DocStateMarkerError (statusCode 400) when the marker is malformed.
function parseDocStateMarker(entryBytes) {
  const text = readMarkerText(textDecode(entryBytes));
  if (text === null) return null;
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new DocStateMarkerError('pages-doc-state marker must be JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new DocStateMarkerError('pages-doc-state marker must be an object');
  }
  if (config.v !== 1) throw new DocStateMarkerError('pages-doc-state v must be 1');
  if (!Number.isInteger(config.iter) || config.iter < MIN_ITER || config.iter > MAX_ITER) {
    throw new DocStateMarkerError(`pages-doc-state iter must be an integer between ${MIN_ITER} and ${MAX_ITER}`);
  }
  const saltLength = base64ByteLength(config.salt);
  if (saltLength === null || saltLength < 16) {
    throw new DocStateMarkerError('pages-doc-state salt must be base64 of at least 16 bytes');
  }
  if (decodedBase64UrlLength(config.verifier) !== 32) {
    throw new DocStateMarkerError('pages-doc-state verifier must be unpadded base64url of 32 bytes');
  }
  return { salt: config.salt, iter: config.iter, verifier: config.verifier };
}

async function registerDocState(env, docId, config, now) {
  const row = await env.PAGES_DB.prepare(
    'SELECT salt, iter, verifier FROM document_state WHERE doc_id = ?',
  ).bind(docId).first();
  if (!row) {
    await env.PAGES_DB.prepare(`
      INSERT INTO document_state (doc_id, salt, iter, verifier, version, blob, updated_at)
      VALUES (?, ?, ?, ?, 0, NULL, NULL)
    `).bind(docId, config.salt, config.iter, config.verifier).run();
    return;
  }
  if (row.salt === config.salt && Number(row.iter) === config.iter && row.verifier === config.verifier) return;
  await env.PAGES_DB.prepare(`
    UPDATE document_state
    SET salt = ?, iter = ?, verifier = ?, blob = NULL, version = version + 1, updated_at = ?
    WHERE doc_id = ?
  `).bind(config.salt, config.iter, config.verifier, now, docId).run();
}

async function readState(env, docId) {
  return env.PAGES_DB.prepare(
    'SELECT verifier, version, blob, updated_at FROM document_state WHERE doc_id = ?',
  ).bind(docId).first();
}

function stateBody(row) {
  return { version: Number(row.version), blob: row.blob ?? null, updatedAt: row.updated_at ?? null };
}

// Results are {status, body}; the worker wraps them with json().
async function getDocState(env, docId) {
  const row = await readState(env, docId);
  if (!row) return { status: 404, body: { error: 'state_not_enabled' } };
  return { status: 200, body: stateBody(row) };
}

async function writeKeyMatches(headerValue, verifier) {
  if (typeof headerValue !== 'string' || decodedBase64UrlLength(headerValue) !== 32) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', base64UrlDecode(headerValue)));
  return safeEqual(base64UrlEncode(digest), verifier);
}

async function putDocState(request, env, docId, now = new Date().toISOString()) {
  const row = await readState(env, docId);
  if (!row) return { status: 404, body: { error: 'state_not_enabled' } };
  if (!(await writeKeyMatches(request.headers.get('X-Pages-Write-Key'), row.verifier))) {
    return { status: 403, body: { error: 'invalid_write_key' } };
  }
  if (Number(request.headers.get('content-length') || 0) > MAX_STATE_BODY_BYTES) {
    return { status: 413, body: { error: 'state_too_large' } };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_STATE_BODY_BYTES) return { status: 413, body: { error: 'state_too_large' } };

  let body;
  try {
    body = JSON.parse(textDecode(bytes));
  } catch {
    return { status: 400, body: { error: 'invalid_state' } };
  }
  if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0
    || typeof body.blob !== 'string') {
    return { status: 400, body: { error: 'invalid_state' } };
  }

  const result = await env.PAGES_DB.prepare(`
    UPDATE document_state SET blob = ?, version = version + 1, updated_at = ?
    WHERE doc_id = ? AND version = ?
  `).bind(body.blob, now, docId, body.baseVersion).run();
  if (result?.meta?.changes === 1) {
    return { status: 200, body: { version: body.baseVersion + 1, updatedAt: now } };
  }
  const current = await readState(env, docId);
  if (!current) return { status: 404, body: { error: 'state_not_enabled' } };
  return { status: 409, body: { error: 'version_conflict', ...stateBody(current) } };
}

export { DocStateMarkerError, MAX_STATE_BODY_BYTES, getDocState, parseDocStateMarker, putDocState, registerDocState };
