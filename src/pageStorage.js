'use strict';

const fs = require('fs');
const path = require('path');

function createPageStorage({ pagesDir }) {
  if (!pagesDir) {
    throw new Error('pagesDir is required');
  }
  fs.mkdirSync(pagesDir, { recursive: true });

  const htmlPath = (id) => path.join(pagesDir, `${id}.html`);
  const metaPath = (id) => path.join(pagesDir, `${id}.json`);

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
    },
    writeHtml(id, html) {
      fs.writeFileSync(htmlPath(id), html, 'utf8');
    },
    readHtml(id) {
      return fs.readFileSync(htmlPath(id), 'utf8');
    },
    deletePage(id) {
      try {
        fs.unlinkSync(htmlPath(id));
      } catch { /* already absent */ }
      try {
        fs.unlinkSync(metaPath(id));
      } catch { /* already absent */ }
    },
    listMetas() {
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
      return pages;
    },
  };
}

module.exports = {
  createPageStorage,
};
