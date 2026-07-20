'use strict';

const DEFAULT_DASHBOARD_LIMIT = 24;
const MAX_DASHBOARD_LIMIT = 50;
const MAX_DASHBOARD_QUERY_LENGTH = 160;
const MAX_UNFURL_TITLE_LENGTH = 300;
const MAX_UNFURL_DESCRIPTION_LENGTH = 1000;
const MAX_UNFURL_IMAGE_LENGTH = 2048;

function createDashboardService({ documents, pageStorage, annotations, baseUrl }) {
  if (!documents || !pageStorage || !baseUrl) {
    throw new Error('documents, pageStorage, and baseUrl are required');
  }

  const annotationStore = annotations || {
    countByRevisionIds: () => ({}),
    list: () => ({ comments: [] }),
  };

  return {
    listDocuments(query = {}) {
      const metaById = new Map(pageStorage.listMetas()
        .filter((meta) => meta?.id)
        .map((meta) => [meta.id, meta]));
      const items = documents.listDocuments().map((documentRecord) => {
        const latestMeta = documentRecord.latestRevision
          ? metaById.get(documentRecord.latestRevision)
          : null;
        return {
          slug: documentRecord.slug,
          title: documentRecord.title,
          owner: documentRecord.owner,
          latestRevision: documentRecord.latestRevision,
          latestRevNumber: documentRecord.latestRevNumber,
          latestRevCreatedAt: documentRecord.latestRevCreatedAt,
          revisionCount: documentRecord.revisionCount,
          createdAt: documentRecord.createdAt,
          updatedAt: documentRecord.updatedAt,
          private: latestMeta?.private === true,
        };
      });
      return paginateForDashboard(items, {
        ...query,
        searchFields: ['title', 'slug'],
      });
    },

    listPages(query = {}) {
      const items = pageStorage
        .listMetas()
        .filter((meta) => meta && !meta.document?.slug)
        .map(toPageListItem)
        .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
      return paginateForDashboard(items, {
        ...query,
        searchFields: ['title'],
      });
    },

    getDocumentDetail(slug, { includeComments = false } = {}) {
      const documentRecord = documents.getDocument(slug);
      if (!documentRecord) return null;

      const revisionIds = documentRecord.revisions.map((revision) => revision.revId);
      const commentCounts = annotationStore.countByRevisionIds(revisionIds);
      const revisions = documentRecord.revisions.map((revision) => {
        const meta = pageStorage.readMeta(revision.revId);
        const item = {
          ...revision,
          private: meta?.private === true,
          reviewable: meta?.reviewable === true,
          commentCount: commentCounts[revision.revId] || 0,
          url: `${baseUrl}/d/${documentRecord.slug}/r/${revision.revNumber}/`,
        };
        if (includeComments) {
          item.comments = annotationStore.list(revision.revId).comments;
        }
        return item;
      });
      const latestRevision = documentRecord.latestRevision || revisions[0]?.revId || null;
      const latestMeta = latestRevision ? pageStorage.readMeta(latestRevision) : null;
      const url = `${baseUrl}/d/${documentRecord.slug}/`;
      return {
        kind: 'documents',
        id: documentRecord.slug,
        ...documentRecord,
        private: latestMeta?.private === true,
        url,
        revisions,
        unfurl: extractUnfurl(safeReadHtml(pageStorage, latestRevision), {
          url,
          fallbackTitle: documentRecord.title,
        }),
      };
    },

    getPageDetail(pageId) {
      const meta = pageStorage.readMeta(pageId);
      if (!meta || meta.document?.slug) return null;
      const url = `${baseUrl}/p/${pageId}/`;
      return {
        kind: 'pages',
        id: pageId,
        title: meta.title || '(제목 없음)',
        createdAt: meta.createdAt || null,
        private: meta.private === true,
        reviewable: meta.reviewable === true,
        url,
        unfurl: extractUnfurl(safeReadHtml(pageStorage, pageId), {
          url,
          fallbackTitle: meta.title || '(제목 없음)',
        }),
      };
    },
  };
}

function paginateForDashboard(items, { cursor, limit, q, searchFields = [] } = {}) {
  const query = normalizeQuery(q);
  const normalizedQuery = query.toLocaleLowerCase('ko');
  const filtered = normalizedQuery
    ? items.filter((item) => searchFields.some((field) => {
      const value = item?.[field];
      return typeof value === 'string' && value.toLocaleLowerCase('ko').includes(normalizedQuery);
    }))
    : items;
  const normalizedLimit = clampPositiveInteger(limit, DEFAULT_DASHBOARD_LIMIT, MAX_DASHBOARD_LIMIT);
  const requestedCursor = nonNegativeInteger(cursor);
  const normalizedCursor = Math.min(requestedCursor, filtered.length);
  const end = Math.min(normalizedCursor + normalizedLimit, filtered.length);
  const nextCursor = end < filtered.length ? end : null;
  return {
    items: filtered.slice(normalizedCursor, end),
    total: filtered.length,
    cursor: normalizedCursor,
    limit: normalizedLimit,
    nextCursor,
    hasMore: nextCursor !== null,
    query,
  };
}

function extractUnfurl(html, { url, fallbackTitle }) {
  const source = typeof html === 'string' ? html : '';
  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? cleanText(titleMatch[1]) : '';
  const meta = collectMeta(source);
  return {
    title: truncate(meta['og:title'] || title || fallbackTitle || '(제목 없음)', MAX_UNFURL_TITLE_LENGTH),
    description: truncate(meta['og:description'] || meta.description || '', MAX_UNFURL_DESCRIPTION_LENGTH),
    image: resolveHttpUrl(truncate(meta['og:image'], MAX_UNFURL_IMAGE_LENGTH), url),
    url,
  };
}

function collectMeta(html) {
  const values = {};
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attributes = parseAttributes(tag);
    const key = String(attributes.property || attributes.name || '').trim().toLowerCase();
    const content = cleanText(attributes.content || '');
    if (key && content && values[key] === undefined) values[key] = content;
  }
  return values;
}

function parseAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) {
    const name = match[1].toLowerCase();
    if (name === '<meta') continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function cleanText(value) {
  return decodeHtmlEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
    if (body[0] === '#') {
      const radix = body[1]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? body.slice(2) : body.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

function resolveHttpUrl(value, baseUrl) {
  if (!value) return '';
  try {
    const resolved = new URL(value, baseUrl);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : '';
  } catch {
    return '';
  }
}

function safeReadHtml(pageStorage, pageId) {
  if (!pageId) return '';
  try {
    return typeof pageStorage.readHtmlSnippet === 'function'
      ? pageStorage.readHtmlSnippet(pageId)
      : pageStorage.readHtml(pageId);
  } catch {
    return '';
  }
}

function truncate(value, maximumLength) {
  return typeof value === 'string' ? value.slice(0, maximumLength) : '';
}

function toPageListItem(meta) {
  return {
    id: meta.id,
    title: meta.title || '(제목 없음)',
    createdAt: meta.createdAt || null,
    private: meta.private === true,
    reviewable: meta.reviewable === true,
  };
}

function normalizeQuery(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_DASHBOARD_QUERY_LENGTH) : '';
}

function clampPositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function timestamp(value) {
  const number = Date.parse(value || '');
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  DEFAULT_DASHBOARD_LIMIT,
  MAX_DASHBOARD_LIMIT,
  createDashboardService,
  extractUnfurl,
  paginateForDashboard,
};
