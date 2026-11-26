'use strict';

const MAX_UNFURL_TITLE_LENGTH = 300;
const MAX_UNFURL_DESCRIPTION_LENGTH = 1000;
const MAX_UNFURL_IMAGE_LENGTH = 2048;

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

function truncate(value, maximumLength) {
  return typeof value === 'string' ? value.slice(0, maximumLength) : '';
}

module.exports = {
  extractUnfurl,
};
