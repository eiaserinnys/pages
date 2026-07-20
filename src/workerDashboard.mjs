import dashboardData from './dashboardData.js';

const { extractUnfurl } = dashboardData;

const DEFAULT_DASHBOARD_LIMIT = 24;
const MAX_DASHBOARD_LIMIT = 50;
const MAX_DASHBOARD_QUERY_LENGTH = 160;
const PAGE_ID_RE = /^[0-9a-f]{12}$/;

export const DASHBOARD_HTML_PREVIEW_BYTES = 256 * 1024;

export function dashboardQuery(request) {
  const url = new URL(request.url);
  return normalizeQuery({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit'),
    q: url.searchParams.get('q'),
  });
}

export async function listDashboardDocuments(env, input = {}) {
  const query = normalizeQuery(input);
  const search = searchSql(['d.title', 'd.slug'], query.q);
  const totalRow = await env.PAGES_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM documents d
    WHERE d.slug IS NOT NULL${search.clause}
  `).bind(...search.values).first();
  const total = countValue(totalRow);
  const cursor = Math.min(query.cursor, total);
  if (!total) return batch([], { ...query, cursor, total });

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
      (SELECT COUNT(*) FROM revisions r WHERE r.doc_id = d.doc_id) AS revision_count
    FROM documents d
    LEFT JOIN revisions lr ON lr.rev_id = d.latest_revision
    WHERE d.slug IS NOT NULL${search.clause}
    ORDER BY d.updated_at DESC, d.doc_id ASC
    LIMIT ? OFFSET ?
  `).bind(...search.values, query.limit, cursor).all();

  const rows = results || [];
  const items = (await Promise.all(rows.map(async (row) => {
    const meta = row.latest_revision ? await readMeta(env, row.latest_revision) : null;
    if (row.latest_revision && !meta) return null;
    return {
      docId: row.doc_id,
      slug: row.slug,
      title: row.title,
      owner: row.owner,
      latestRevision: row.latest_revision,
      latestRevNumber: row.latest_rev_number,
      latestRevCreatedAt: row.latest_rev_created_at,
      revisionCount: Number(row.revision_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      private: meta?.private === true,
    };
  }))).filter(Boolean);
  return batch(items, { ...query, cursor, total, consumed: rows.length });
}

export async function listDashboardPages(env, input = {}) {
  const query = normalizeQuery(input);
  const search = searchSql(['d.title'], query.q);
  const totalRow = await env.PAGES_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM documents d
    WHERE d.slug IS NULL
      AND d.latest_revision IS NOT NULL${search.clause}
  `).bind(...search.values).first();
  const total = countValue(totalRow);
  const cursor = Math.min(query.cursor, total);
  if (!total) return batch([], { ...query, cursor, total });

  const { results } = await env.PAGES_DB.prepare(`
    SELECT
      d.latest_revision AS id,
      d.title,
      d.updated_at,
      COALESCE(r.created_at, d.created_at) AS created_at
    FROM documents d
    LEFT JOIN revisions r ON r.rev_id = d.latest_revision
    WHERE d.slug IS NULL
      AND d.latest_revision IS NOT NULL${search.clause}
    ORDER BY d.updated_at DESC, d.doc_id ASC
    LIMIT ? OFFSET ?
  `).bind(...search.values, query.limit, cursor).all();

  const rows = results || [];
  const items = (await Promise.all(rows.map(async (row) => {
    const meta = await readMeta(env, row.id);
    if (!meta) return null;
    return {
      id: row.id,
      title: meta?.title || row.title || '(제목 없음)',
      createdAt: meta?.createdAt || row.created_at || row.updated_at,
      private: meta?.private === true,
      reviewable: meta?.reviewable === true,
    };
  }))).filter(Boolean);
  return batch(items, { ...query, cursor, total, consumed: rows.length });
}

export async function getDashboardDocumentDetail(env, slug, baseUrl) {
  const documentRow = await env.PAGES_DB.prepare(`
    SELECT doc_id, slug, title, owner, latest_revision, created_at, updated_at
    FROM documents
    WHERE slug = ?
  `).bind(slug).first();
  if (!documentRow) return null;

  const { results } = await env.PAGES_DB.prepare(`
    SELECT
      r.rev_id,
      r.doc_id,
      r.rev_number,
      r.status,
      r.created_at,
      (SELECT COUNT(*) FROM comments c WHERE c.rev_id = r.rev_id) AS comment_count
    FROM revisions r
    WHERE r.doc_id = ?
    ORDER BY r.rev_number DESC
  `).bind(documentRow.doc_id).all();

  const root = trimBaseUrl(baseUrl);
  const revisions = await Promise.all((results || []).map(async (row) => {
    const meta = await readMeta(env, row.rev_id);
    return {
      revId: row.rev_id,
      docId: row.doc_id,
      revNumber: row.rev_number,
      status: row.status,
      createdAt: row.created_at,
      private: meta?.private === true,
      reviewable: meta?.reviewable === true,
      commentCount: Number(row.comment_count || 0),
      url: `${root}/d/${documentRow.slug}/r/${row.rev_number}/`,
    };
  }));
  const latestMeta = documentRow.latest_revision
    ? await readMeta(env, documentRow.latest_revision)
    : null;
  const url = `${root}/d/${documentRow.slug}/`;
  const preview = await readHtmlPreview(env, documentRow.latest_revision);
  return {
    kind: 'documents',
    id: documentRow.slug,
    docId: documentRow.doc_id,
    slug: documentRow.slug,
    title: documentRow.title,
    owner: documentRow.owner,
    latestRevision: documentRow.latest_revision,
    createdAt: documentRow.created_at,
    updatedAt: documentRow.updated_at,
    private: latestMeta?.private === true,
    url,
    revisions,
    unfurl: extractUnfurl(preview, { url, fallbackTitle: documentRow.title }),
  };
}

export async function setDashboardDocumentVisibility(env, slug, privateValue) {
  const documentRow = await env.PAGES_DB.prepare(`
    SELECT doc_id, slug
    FROM documents
    WHERE slug = ?
  `).bind(slug).first();
  if (!documentRow) return { status: 'not_found' };

  const { results } = await env.PAGES_DB.prepare(`
    SELECT rev_id
    FROM revisions
    WHERE doc_id = ?
    ORDER BY rev_number DESC
  `).bind(documentRow.doc_id).all();
  const revisionIds = (results || []).map((row) => row.rev_id);
  const invalidStoredIds = revisionIds.filter((id) => !PAGE_ID_RE.test(id || ''));
  if (!revisionIds.length || invalidStoredIds.length) {
    return { status: 'invalid_metadata', invalidRevisionIds: invalidStoredIds };
  }

  const currentMetas = await Promise.all(revisionIds.map(async (id) => ({ id, meta: await readMeta(env, id) })));
  const invalidRevisionIds = currentMetas.filter((entry) => !entry.meta).map((entry) => entry.id);
  if (invalidRevisionIds.length) return { status: 'invalid_metadata', invalidRevisionIds };

  const updated = [];
  try {
    for (const entry of currentMetas) {
      await writeMeta(env, entry.id, { ...entry.meta, private: privateValue });
      updated.push(entry);
    }
  } catch (error) {
    await Promise.allSettled(updated.map((entry) => writeMeta(env, entry.id, entry.meta)));
    throw error;
  }

  return {
    status: 'updated',
    slug: documentRow.slug,
    private: privateValue,
    revisionCount: revisionIds.length,
    updatedRevisionIds: revisionIds,
  };
}

export async function getDashboardPageDetail(env, pageId, baseUrl) {
  if (!PAGE_ID_RE.test(pageId)) return null;
  const row = await env.PAGES_DB.prepare(`
    SELECT d.title, d.created_at, d.updated_at, r.created_at AS revision_created_at
    FROM revisions r
    JOIN documents d ON d.doc_id = r.doc_id
    WHERE r.rev_id = ?
      AND d.slug IS NULL
      AND d.latest_revision = r.rev_id
  `).bind(pageId).first();
  if (!row) return null;

  const meta = await readMeta(env, pageId);
  const root = trimBaseUrl(baseUrl);
  const url = `${root}/p/${pageId}/`;
  const title = meta?.title || row.title || '(제목 없음)';
  const preview = await readHtmlPreview(env, pageId);
  return {
    kind: 'pages',
    id: pageId,
    title,
    createdAt: meta?.createdAt || row.revision_created_at || row.created_at || row.updated_at,
    private: meta?.private === true,
    reviewable: meta?.reviewable === true,
    url,
    unfurl: extractUnfurl(preview, { url, fallbackTitle: title }),
  };
}

export async function deleteDashboardPageData(env, pageId) {
  if (!PAGE_ID_RE.test(pageId)) return { found: false, assetKeys: [] };
  const document = await env.PAGES_DB.prepare(`
    SELECT d.doc_id
    FROM revisions r
    JOIN documents d ON d.doc_id = r.doc_id
    WHERE r.rev_id = ?
      AND d.slug IS NULL
      AND d.latest_revision = r.rev_id
  `).bind(pageId).first();
  if (!document) return { found: false, assetKeys: [] };

  const { results } = await env.PAGES_DB.prepare(`
    SELECT bytes_key
    FROM revision_assets
    WHERE rev_id = ?
  `).bind(pageId).all();
  const assetKeys = (results || []).map((row) => row.bytes_key).filter(Boolean);
  await env.PAGES_DB.batch([
    env.PAGES_DB.prepare('DELETE FROM comments WHERE rev_id = ?').bind(pageId),
    env.PAGES_DB.prepare('DELETE FROM webhook_secrets WHERE rev_id = ?').bind(pageId),
    env.PAGES_DB.prepare('DELETE FROM revision_assets WHERE rev_id = ?').bind(pageId),
    env.PAGES_DB.prepare('DELETE FROM revision_bundles WHERE rev_id = ?').bind(pageId),
    env.PAGES_DB.prepare('DELETE FROM revisions WHERE rev_id = ?').bind(pageId),
    env.PAGES_DB.prepare('DELETE FROM documents WHERE doc_id = ?').bind(document.doc_id),
  ]);
  return { found: true, assetKeys };
}

export async function readHtmlPreview(env, pageId) {
  if (!PAGE_ID_RE.test(pageId || '')) return '';
  try {
    const object = await env.PAGES_BUCKET.get(`pages/${pageId}.html`, {
      range: { offset: 0, length: DASHBOARD_HTML_PREVIEW_BYTES },
    });
    if (!object) return '';
    const buffer = await object.arrayBuffer();
    const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, DASHBOARD_HTML_PREVIEW_BYTES));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

async function readMeta(env, pageId) {
  if (!PAGE_ID_RE.test(pageId || '')) return null;
  try {
    const object = await env.PAGES_BUCKET.get(`pages/${pageId}.json`);
    return object ? JSON.parse(await object.text()) : null;
  } catch {
    return null;
  }
}

async function writeMeta(env, pageId, meta) {
  await env.PAGES_BUCKET.put(`pages/${pageId}.json`, JSON.stringify(meta, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

function normalizeQuery(input) {
  const cursorNumber = Number(input.cursor);
  const limitNumber = Number(input.limit);
  return {
    cursor: Number.isInteger(cursorNumber) && cursorNumber >= 0 ? cursorNumber : 0,
    limit: Number.isInteger(limitNumber) && limitNumber > 0
      ? Math.min(limitNumber, MAX_DASHBOARD_LIMIT)
      : DEFAULT_DASHBOARD_LIMIT,
    q: typeof input.q === 'string' ? input.q.trim().slice(0, MAX_DASHBOARD_QUERY_LENGTH) : '',
  };
}

function searchSql(fields, query) {
  if (!query) return { clause: '', values: [] };
  const pattern = `%${escapeLike(query.toLocaleLowerCase('ko'))}%`;
  return {
    clause: ` AND (${fields.map((field) => `LOWER(COALESCE(${field}, '')) LIKE ? ESCAPE '!'`).join(' OR ')})`,
    values: fields.map(() => pattern),
  };
}

function escapeLike(value) {
  return value.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

function batch(items, { cursor, limit, q, total, consumed = items.length }) {
  const end = cursor + consumed;
  const nextCursor = consumed > 0 && end < total ? end : null;
  return {
    items,
    total,
    cursor,
    limit,
    nextCursor,
    hasMore: nextCursor !== null,
    query: q,
  };
}

function countValue(row) {
  return Math.max(0, Number(row?.count || 0));
}

function trimBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}
