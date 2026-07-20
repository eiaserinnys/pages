'use strict';

const express = require('express');
const { renderDashboard, renderDocumentDetail } = require('./dashboard');
const { DEFAULT_DASHBOARD_LIMIT } = require('./dashboardData');
const { isValidDocumentSlug } = require('./documentStore');

const PAGE_ID_PATTERN = /^[0-9a-f]{12}$/;

function createDashboardRouter({ requireAuth, service, baseUrl }) {
  if (typeof requireAuth !== 'function' || !service || !baseUrl) {
    throw new Error('requireAuth, service, and baseUrl are required');
  }
  const router = express.Router();

  router.get('/api/dashboard/documents', requireAuth, (req, res) => {
    res.json(service.listDocuments(dashboardQuery(req)));
  });

  router.get('/api/dashboard/pages', requireAuth, (req, res) => {
    res.json(service.listPages(dashboardQuery(req)));
  });

  router.get('/api/dashboard/documents/:slug', requireAuth, (req, res) => {
    if (!isValidDocumentSlug(req.params.slug)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const detail = service.getDocumentDetail(req.params.slug);
    return detail ? res.json(detail) : res.status(404).json({ error: 'Not found' });
  });

  router.get('/api/dashboard/pages/:pageId', requireAuth, (req, res) => {
    if (!PAGE_ID_PATTERN.test(req.params.pageId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const detail = service.getPageDetail(req.params.pageId);
    return detail ? res.json(detail) : res.status(404).json({ error: 'Not found' });
  });

  const sendDashboard = (req, res) => {
    const initialQuery = { cursor: 0, limit: DEFAULT_DASHBOARD_LIMIT, q: '' };
    const documents = service.listDocuments(initialQuery);
    const pages = service.listPages(initialQuery);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderDashboard({ documents, pages, baseUrl }));
  };

  router.get('/', requireAuth, sendDashboard);
  router.get('/dashboard', requireAuth, sendDashboard);

  router.get('/dashboard/documents/:slug', requireAuth, (req, res) => {
    const { slug } = req.params;
    if (!isValidDocumentSlug(slug)) return res.status(404).send('<h1>404 Not Found</h1>');
    const detail = service.getDocumentDetail(slug, { includeComments: true });
    if (!detail) return res.status(404).send('<h1>404 Not Found</h1>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderDocumentDetail({
      documentRecord: detail,
      revisions: detail.revisions,
      baseUrl,
    }));
  });

  return router;
}

function dashboardQuery(req) {
  return {
    cursor: req.query.cursor,
    limit: req.query.limit,
    q: req.query.q,
  };
}

module.exports = {
  createDashboardRouter,
};
