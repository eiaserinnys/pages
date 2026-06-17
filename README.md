# pages

A lightweight HTML page hosting service. Clients upload HTML via a Bearer-token-authenticated API and receive a unique public URL; a Google OAuth-protected dashboard lets authorized users manage visibility and deletion.

![Dashboard](pages.jpg)

## Features

- **HTML upload** — POST any HTML string and get back a stable `/p/:id` URL
- **Document revisions** — opt-in `/d/:slug` stable URLs keep a revision history without changing anonymous uploads
- **Multifile bundles** — opt-in manifest upload serves `index.html` plus relative assets under `/p/:id/...` and `/d/:slug/...`
- **Review annotations** — opt-in reviewable pages receive rev-scoped comment storage
- **Public / private toggle** — pages default to public; flip visibility from the dashboard
- **Google OAuth dashboard** — only allowlisted Google accounts can access `/` and manage pages
- **Bearer token auth** — API writes require `Authorization: Bearer <token>`
- **Bundle limits** — uploads are capped at 200 files and 50 MB per bundle

## Environment Variables

Create a `.env` file in the project root (see `.env.example` if present):

| Variable              | Description                                                    |
|-----------------------|----------------------------------------------------------------|
| `PORT`                | Port the server listens on (e.g. `3110`)                       |
| `PAGES_DIR`           | Absolute path to the directory where pages are stored          |
| `PAGES_API_TOKEN`     | Secret token required for `POST /api/pages`                    |
| `SESSION_SECRET`      | Secret used to sign the session cookie                         |
| `BASE_URL`            | Public base URL without trailing slash (e.g. `https://pages.example.com`) |
| `GOOGLE_CLIENT_ID`    | Google OAuth 2.0 client ID                                     |
| `GOOGLE_CLIENT_SECRET`| Google OAuth 2.0 client secret                                 |
| `ALLOWED_EMAILS`      | Comma-separated list of Google email addresses allowed to log in |

All variables are required. The server throws an error on startup if any are missing.

The annotation metadata database is stored as `pages-meta.sqlite` inside `PAGES_DIR`.

## API

### Upload a page

```
POST /api/pages
Authorization: Bearer <PAGES_API_TOKEN>
Content-Type: application/json

{
  "html": "<html>...</html>",
  "title": "My Report",      // optional, defaults to "(제목 없음)"
  "doc": "my-report",        // optional, opt-in stable document slug
  "private": false,          // optional, defaults to false
  "reviewable": false,       // optional, defaults to false
  "webhookUrl": "https://example.com/hook", // optional, requires reviewable=true
  "webhookSecret": "<signing secret>"       // optional, requires webhookUrl
}
```

**Response `201`**

```json
{
  "id": "a1b2c3d4e5f6",
  "url": "https://pages.example.com/p/a1b2c3d4e5f6"
}
```

If `reviewable` is `true`, the response also includes a rev-scoped capability token and the stored HTML receives an inline `window.__PAGES_REVIEW__` config:

```json
{
  "id": "a1b2c3d4e5f6",
  "url": "https://pages.example.com/p/a1b2c3d4e5f6",
  "review": {
    "revId": "a1b2c3d4e5f6",
    "annotationsUrl": "/api/annotations/a1b2c3d4e5f6",
    "tokenHeader": "X-Pages-Annotation-Token",
    "capabilityToken": "<rev-scoped-token>",
    "expiresAt": "2026-06-29T00:00:00.000Z",
    "webhook": {
      "enabled": true,
      "signed": true
    }
  }
}
```

If `doc` is present, the page is appended as a new immutable revision under that document slug. The response keeps the existing `id` and `url` fields and adds document fields:

```json
{
  "id": "b2c3d4e5f6a7",
  "url": "https://pages.example.com/p/b2c3d4e5f6a7",
  "docId": "doc_123abc456def",
  "revId": "b2c3d4e5f6a7",
  "revNumber": 2,
  "stableUrl": "https://pages.example.com/d/my-report",
  "revisionUrl": "https://pages.example.com/d/my-report/r/2"
}
```

`doc` is opt-in. If it is omitted, the response shape is unchanged and the backend only records an internal anonymous one-revision document. Slugs must match `^[a-z0-9][a-z0-9_-]{2,63}$`; reserved route names such as `p`, `d`, `api`, and `auth` are rejected.

`webhookUrl` and `webhookSecret` are accepted only for reviewable pages. Page metadata stores `review.webhookUrl` and, when signing is enabled, `review.webhookSecretHash`; the raw signing secret is kept in the SQLite metadata store, not in the page JSON metadata or injected HTML.

For multifile bundles, send `files` instead of `html`. Each file is base64 encoded and addressed by a safe relative POSIX path. The single HTML upload above is treated internally as a one-file bundle with `index.html`, but its response remains exactly `{ id, url }` unless optional features such as `doc` or `reviewable` are requested.

```json
{
  "title": "My Report",
  "entrypoint": "index.html",
  "files": [
    {
      "path": "index.html",
      "content": "PGh0bWw+Li4uPC9odG1sPg==",
      "encoding": "base64",
      "contentType": "text/html; charset=utf-8"
    },
    {
      "path": "assets/style.css",
      "content": "Ym9keSB7IGNvbG9yOiByZWQ7IH0=",
      "encoding": "base64",
      "contentType": "text/css; charset=utf-8"
    }
  ]
}
```

Bundle paths reject traversal and ambiguous platform paths: `..`, absolute paths, backslashes, NULL bytes, empty segments, and Windows reserved names such as `CON` and `NUL`. Server limits are 200 files and 50 MB total bytes per bundle.

### Document revisions

```
GET /d/:slug
```

Redirects to the latest published revision URL, `/d/:slug/r/:revNumber`.

```
GET /d/:slug/r/:revNumber
```

Serves that fixed revision's HTML. Revision URLs do not move when newer revisions are published.

```
GET /p/:pageId/:path
GET /d/:slug/:path
GET /d/:slug/r/:revNumber/:path
```

Serve bundle assets from the immutable page, the latest document revision, or a fixed revision. Unknown manifest paths return `404`; content type comes from the stored manifest or extension inference.

```
GET /api/documents/:slug
```

Returns document metadata and revisions in newest-first order:

```json
{
  "docId": "doc_123abc456def",
  "slug": "my-report",
  "title": "My Report",
  "owner": "api",
  "latestRevision": "b2c3d4e5f6a7",
  "stableUrl": "https://pages.example.com/d/my-report",
  "createdAt": "2026-06-15T00:00:00.000Z",
  "updatedAt": "2026-06-15T01:00:00.000Z",
  "revisions": [
    {
      "revId": "b2c3d4e5f6a7",
      "revNumber": 2,
      "status": "published",
      "createdAt": "2026-06-15T01:00:00.000Z",
      "pageUrl": "https://pages.example.com/p/b2c3d4e5f6a7",
      "revisionUrl": "https://pages.example.com/d/my-report/r/2"
    }
  ]
}
```

Review comments remain scoped to a single `revId`. Publishing a new revision starts with an empty comment set; unresolved comments are not carried over automatically.

### Annotation comments

```
GET /api/annotations/:revId
```

Returns the comments payload for one reviewable revision. Non-reviewable pages return `404`.

```
PUT /api/annotations/:revId
X-Pages-Annotation-Token: <capability token>
Content-Type: application/json

{
  "schema_version": "1.0",
  "document_id": "a1b2c3d4e5f6",
  "comments": []
}
```

`PUT` replaces the full comment set for the revision. The capability token is scoped to the single `revId` and expires automatically.

If the page has `review.webhookUrl`, a successful `PUT` queues a fire-and-forget webhook POST:

```json
{
  "event": "pages.annotations.updated",
  "rev_id": "a1b2c3d4e5f6",
  "count": 3,
  "annotations_url": "/api/annotations/a1b2c3d4e5f6",
  "page_url": "/p/a1b2c3d4e5f6",
  "timestamp": "2026-06-15T00:00:00.000Z"
}
```

When a webhook secret is configured, the request includes:

```
X-Pages-Webhook-Signature: sha256=<hex hmac over the exact JSON body>
```

Webhook delivery has a 5 second timeout, logs failures to stderr, and does not retry. Delivery failure does not change the `PUT` response.

### Other endpoints

| Method   | Path                             | Auth          | Description            |
|----------|----------------------------------|---------------|------------------------|
| `GET`    | `/p/:pageId`                     | none (public) | Serve the page         |
| `GET`    | `/p/:pageId/:path`               | none (public) | Serve page bundle asset |
| `GET`    | `/d/:slug`                       | none (public) | Redirect to latest revision |
| `GET`    | `/d/:slug/:path`                 | none (public) | Serve latest revision bundle asset |
| `GET`    | `/d/:slug/r/:revNumber`          | none (public) | Serve a fixed revision |
| `GET`    | `/d/:slug/r/:revNumber/:path`    | none (public) | Serve fixed revision bundle asset |
| `GET`    | `/api/documents/:slug`           | none          | Show document metadata |
| `GET`    | `/api/annotations/:revId`        | none          | List review comments   |
| `PUT`    | `/api/annotations/:revId`        | capability    | Replace review comments |
| `PATCH`  | `/api/pages/:pageId/visibility`  | Google OAuth  | Toggle public/private  |
| `DELETE` | `/api/pages/:pageId`             | Google OAuth  | Delete a page          |
| `GET`    | `/`                              | Google OAuth  | Admin dashboard        |

## Running

```bash
npm install
node src/server.js
```

With pm2 (production):

```bash
pm2 start ecosystem.config.js
```

The `ecosystem.config.js` sets `cwd` via `process.env.HOME` to the symlink path managed by the deployment system. Do not change this to a relative path — the symlink is stable and pm2's working directory at startup time is not.

## Cloudflare Worker Backend

The repository includes a staged Cloudflare Worker implementation in `src/worker.mjs`. It is not wired to `pages.eiaserinnys.me` by default.

Cloudflare resources:

- D1 database: `pages` (`af7049be-6ba5-4261-bc05-e5773d3eec33`)
- Private R2 bucket: `pages-content`
- Existing public R2 bucket for externally shareable assets: `pages-assets`

The Worker keeps uploaded page HTML and bundle files in the private `pages-content` bucket so private pages are not exposed through a public R2 URL. D1 replaces the current `pages-meta.sqlite` metadata store for documents, revisions, annotations, webhook secrets, and revision asset manifests.

Required Worker secrets:

```bash
npx --yes wrangler@4.86.0 secret put PAGES_API_TOKEN
npx --yes wrangler@4.86.0 secret put SESSION_SECRET
npx --yes wrangler@4.86.0 secret put GOOGLE_CLIENT_ID
npx --yes wrangler@4.86.0 secret put GOOGLE_CLIENT_SECRET
```

Non-secret Worker variables and bindings live in `wrangler.toml`. The custom-domain route is intentionally commented out until migration and smoke testing are complete.

The `main` branch is deployed to Cloudflare Worker by `.github/workflows/cloudflare-worker.yml` after tests and `worker:dry-run` pass. Push deployments intentionally stop when `migrations/**` changed; run the workflow manually with `apply_d1_migrations=true` for schema changes.

Suggested cutover sequence:

1. Set Worker secrets with `npm run worker:set-secrets -- --source-env /home/eias/services/pages/shared/.env`.
2. Apply D1 migrations with `npm run worker:migrate:d1`.
3. Copy the current Express data from `PAGES_DIR` into D1 and the `pages-content` R2 bucket:

```bash
npm run worker:migrate:data -- \
  --source-dir /home/eias/services/pages/shared/pages \
  --apply-schema
```

4. Deploy the Worker to the workers.dev staging URL and smoke test uploads, public pages, private-page OAuth, document revisions, bundle assets, review annotations, and webhooks.
5. Uncomment the `pages.eiaserinnys.me` route in `wrangler.toml` and deploy during an approved cutover window.
