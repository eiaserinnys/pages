'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_HTML_SNIPPET_BYTES = 256 * 1024;

function createPageStorage({ pagesDir }) {
  if (!pagesDir) {
    throw new Error('pagesDir is required');
  }
  fs.mkdirSync(pagesDir, { recursive: true });

  const htmlPath = (id) => path.join(pagesDir, `${id}.html`);
  const metaPath = (id) => path.join(pagesDir, `${id}.json`);
  let metaListCache = null;

  return {
    htmlPath,
    metaPath,
    readMeta(id) {
      try {
        return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
      } catch {
        return null;
      }
    },
    writeMeta(id, data) {
      fs.writeFileSync(metaPath(id), JSON.stringify(data, null, 2), 'utf8');
      metaListCache = null;
    },
    writeHtml(id, html) {
      fs.writeFileSync(htmlPath(id), html, 'utf8');
    },
    readHtml(id) {
      return fs.readFileSync(htmlPath(id), 'utf8');
    },
    readHtmlSnippet(id, maxBytes = DEFAULT_HTML_SNIPPET_BYTES) {
      const byteLimit = Number.isInteger(maxBytes) && maxBytes > 0
        ? maxBytes
        : DEFAULT_HTML_SNIPPET_BYTES;
      const file = fs.openSync(htmlPath(id), 'r');
      try {
        const length = Math.min(fs.fstatSync(file).size, byteLimit);
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(file, buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        fs.closeSync(file);
      }
    },
    deletePage(id) {
      try {
        fs.unlinkSync(htmlPath(id));
      } catch { /* already absent */ }
      try {
        fs.unlinkSync(metaPath(id));
      } catch { /* already absent */ }
      metaListCache = null;
    },
    listMetas() {
      if (metaListCache) return metaListCache;
      const pages = [];
      let files = [];
      try {
        files = fs.readdirSync(pagesDir).filter((file) => file.endsWith('.json'));
      } catch {
        return pages;
      }
      for (const file of files) {
        try {
          pages.push(JSON.parse(fs.readFileSync(path.join(pagesDir, file), 'utf8')));
        } catch { /* ignore broken metadata */ }
      }
      metaListCache = pages;
      return metaListCache;
    },
  };
}

module.exports = {
  createPageStorage,
};
