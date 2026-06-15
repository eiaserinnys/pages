'use strict';

const { BundleStoreError, normalizeUploadBundle, withPatchedEntrypoint } = require('./bundleStore');
const { issueAnnotationToken } = require('./capabilityTokens');
const { DocumentStoreError } = require('./documentStore');
const { injectReviewConfig } = require('./reviewBundle');
const { WebhookConfigurationError } = require('./webhooks');

function createPageUploadHandler({
  documents,
  bundles,
  pageStorage,
  newPageId,
  baseUrl,
  sessionSecret,
  annotationTokenTtlSeconds,
  annotationTokenHeader,
  normalizeReviewWebhook,
}) {
  return (req, res) => {
    const {
      html,
      files,
      entrypoint,
      title,
      private: isPrivate,
      reviewable,
      webhookUrl,
      webhookSecret,
      doc,
      owner,
    } = req.body;
    let bundle;
    try {
      bundle = normalizeUploadBundle({ html, files, entrypoint });
    } catch (err) {
      if (err instanceof BundleStoreError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      throw err;
    }
    const validationError = validateUploadOptions({ reviewable, webhookUrl, webhookSecret, doc, owner });
    if (validationError) return res.status(400).json({ error: validationError });

    const id = newPageId();
    const pageTitle = title || '(제목 없음)';
    const createdAt = new Date().toISOString();
    const docSlug = doc === undefined || doc === null ? '' : doc;
    const wantsReviewable = reviewable === true;
    let review = null;
    let webhook = null;
    let documentRecord = null;
    if (wantsReviewable) {
      const reviewResult = prepareReviewableBundle({
        id,
        bundle,
        sessionSecret,
        annotationTokenTtlSeconds,
        annotationTokenHeader,
      });
      if (reviewResult.error) return res.status(reviewResult.error.statusCode).json({ error: reviewResult.error.message });
      review = reviewResult.review;
      bundle = reviewResult.bundle;
      try {
        webhook = normalizeReviewWebhook(id, webhookUrl, webhookSecret);
      } catch (err) {
        if (err instanceof WebhookConfigurationError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }

    try {
      if (docSlug) {
        documentRecord = documents.appendRevision({
          slug: docSlug,
          revId: id,
          title: pageTitle,
          owner,
          createdAt,
        });
      } else {
        documents.ensureAnonymousRevision({
          revId: id,
          title: pageTitle,
          owner,
          createdAt,
        });
      }
    } catch (err) {
      if (err instanceof DocumentStoreError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const revisionDocument = documents.getRevisionDocument(id);
    if (!revisionDocument) return res.status(500).json({ error: 'Failed to create revision metadata' });

    let bundleManifest = null;
    try {
      bundleManifest = bundles.replaceBundle({
        revId: id,
        docId: revisionDocument.docId,
        entrypoint: bundle.entrypoint,
        files: bundle.files,
        createdAt,
      });
    } catch (err) {
      if (err instanceof BundleStoreError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      throw err;
    }
    const entrypointFile = bundle.files.find((file) => file.path === bundle.entrypoint);
    pageStorage.writeHtml(id, entrypointFile.bytes.toString('utf8'));

    const meta = buildPageMeta({
      id,
      pageTitle,
      createdAt,
      isPrivate,
      documentRecord,
      review,
      webhook,
      bundleManifest,
    });
    pageStorage.writeMeta(id, meta);

    const response = buildUploadResponse({ id, baseUrl, documentRecord, review });
    return res.status(201).json(response);
  };
}

function validateUploadOptions({ reviewable, webhookUrl, webhookSecret, doc, owner }) {
  if (reviewable !== true && (webhookUrl || webhookSecret)) return 'webhook requires reviewable=true';
  if (webhookSecret !== undefined && typeof webhookSecret !== 'string') return 'webhookSecret must be a string';
  if (webhookSecret && !webhookUrl) return 'webhookSecret requires webhookUrl';
  if (doc !== undefined && doc !== null && typeof doc !== 'string') return 'doc must be a string';
  if (owner !== undefined && owner !== null && typeof owner !== 'string') return 'owner must be a string';
  return '';
}

function prepareReviewableBundle({
  id,
  bundle,
  sessionSecret,
  annotationTokenTtlSeconds,
  annotationTokenHeader,
}) {
  const token = issueAnnotationToken({
    revId: id,
    secret: sessionSecret,
    ttlSeconds: annotationTokenTtlSeconds,
  });
  const review = {
    revId: id,
    annotationsUrl: `/api/annotations/${id}`,
    tokenHeader: annotationTokenHeader,
    capabilityToken: token.token,
    expiresAt: token.expiresAt,
  };
  try {
    return {
      review,
      bundle: withPatchedEntrypoint(bundle, (entryHtml) => injectReviewConfig(entryHtml, review)),
    };
  } catch (err) {
    if (err instanceof BundleStoreError) return { error: err };
    throw err;
  }
}

function buildPageMeta({
  id,
  pageTitle,
  createdAt,
  isPrivate,
  documentRecord,
  review,
  webhook,
  bundleManifest,
}) {
  const meta = {
    id,
    title: pageTitle,
    createdAt,
    private: isPrivate === true,
    bundle: {
      entrypoint: bundleManifest.entrypoint,
      fileCount: bundleManifest.fileCount,
      totalSizeBytes: bundleManifest.totalSizeBytes,
      assets: bundleManifest.assets,
    },
  };
  if (documentRecord?.slug) {
    const revision = documentRecord.revision;
    meta.document = {
      docId: documentRecord.docId,
      slug: documentRecord.slug,
      owner: documentRecord.owner,
      revId: id,
      revNumber: revision.revNumber,
      stableUrl: `/d/${documentRecord.slug}`,
      revisionUrl: `/d/${documentRecord.slug}/r/${revision.revNumber}`,
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
    const revision = documentRecord.revision;
    response.docId = documentRecord.docId;
    response.revId = id;
    response.revNumber = revision.revNumber;
    response.stableUrl = `${baseUrl}/d/${documentRecord.slug}`;
    response.revisionUrl = `${baseUrl}/d/${documentRecord.slug}/r/${revision.revNumber}`;
  }
  if (review) response.review = review;
  return response;
}

module.exports = {
  createPageUploadHandler,
};
