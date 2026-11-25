# Document state

A document published with `doc` (a slug) can opt in to a server-side state that is locked by a password. The server never sees the password or the plaintext. The browser encrypts the state, the server keeps the opaque string and a version number, and a write is accepted only with a write key derived from the same password.

## Marker in the entry HTML

If the entry HTML of an upload (the single `html`, or the bundle `entrypoint`) contains this element, the document uses server state:

```html
<script type="application/json" id="pages-doc-state">{"v":1,"iter":120000,"salt":"<base64, 16 bytes or more>","verifier":"<base64url, no padding, 32 bytes>"}</script>
```

| Field      | Rule                                                        |
|------------|-------------------------------------------------------------|
| `v`        | Must be `1`.                                                |
| `iter`     | Integer from 10000 to 1000000 (PBKDF2 iterations).          |
| `salt`     | Standard base64 that decodes to at least 16 bytes.          |
| `verifier` | base64url without padding that decodes to exactly 32 bytes. |

A malformed marker rejects the upload with `400`; no revision is created. Uploads without a `doc` slug ignore the marker.

On a successful publish (after the bundle is stored) the Worker registers the marker in the D1 table `document_state` (`migrations/006_document_state.sql`):

- No row yet: create it with version 0 and no blob.
- Same `salt`, `iter` and `verifier`: leave the row alone, so the version and blob stay.
- Any of the three differs (a republish with a changed password or salt): store the new settings, clear the blob and raise the version by 1.
- No marker in the upload: the existing row is untouched.

## Keys

```
bits     = PBKDF2-SHA256(UTF-8 password, salt, iter, 512 bits)
encKey   = bits[0..32]   AES-GCM-256 key for the state blob
writeKey = bits[32..64]  sent as X-Pages-Write-Key (base64url)
verifier = base64url(SHA-256(writeKey))
```

The page computes `verifier` from the typed password and compares it with the marker to detect a wrong password before any request.

State blob: the string `{"v":1,"iv":"<base64, 12 bytes>","ct":"<base64>"}`, where `ct` is the AES-GCM encryption (`encKey`, fresh random `iv`) of the UTF-8 JSON value. The server treats it as an opaque string.

## API

Both routes use the slug validation of `GET /api/documents/:slug`, answer JSON with `Cache-Control: no-store`, send no CORS headers (same-origin pages only), and answer `405` to other methods. If the latest revision is private, they need the same Google session or OAuth Bearer token as the document API (`401` otherwise).

### `GET /api/documents/:slug/state`

| Status | Body                                                             |
|--------|------------------------------------------------------------------|
| 200    | `{"version":N,"blob":"<string or null>","updatedAt":"<ISO or null>"}` |
| 404    | `{"error":"document_not_found"}` or `{"error":"state_not_enabled"}` |

### `PUT /api/documents/:slug/state`

Header `X-Pages-Write-Key: <base64url writeKey, 32 bytes>`. The Worker hashes it with SHA-256 and compares the base64url result to the stored `verifier`. Body: `{"baseVersion":<integer >= 0>,"blob":"<string>"}`, at most 1 MiB.

| Status | Body                                                                                   |
|--------|----------------------------------------------------------------------------------------|
| 200    | `{"version":baseVersion+1,"updatedAt":"<ISO>"}`                                        |
| 400    | `{"error":"invalid_state"}` (bad JSON or shape)                                        |
| 403    | `{"error":"invalid_write_key"}` (header missing or wrong)                              |
| 404    | `document_not_found` or `state_not_enabled`                                            |
| 409    | `{"error":"version_conflict","version":N,"blob":"<current>","updatedAt":...}`          |
| 413    | `{"error":"state_too_large"}`                                                          |

The update is a single `UPDATE ... WHERE doc_id = ? AND version = ?`, so two writers with the same `baseVersion` cannot both win. On `409`, merge the returned blob and retry with the returned `version`.

## Reference client

`client/pagesDocState.js` is a plain browser script (no `import` or `export`) that defines `globalThis.PagesDocState`. Inline it into the page.

| Function                                      | Result                                                                  |
|-----------------------------------------------|-------------------------------------------------------------------------|
| `readConfig(root)`                            | The parsed marker, or `null` when absent.                               |
| `deriveKeys(password, config)`                | `{encKey, writeKey (base64url), verified}`                              |
| `encryptState(encKey, value)`                 | Blob string.                                                            |
| `decryptState(encKey, blob)`                  | The original value.                                                     |
| `fetchState(slug, opts)`                      | `{version, blob, updatedAt}`; throws an Error with `status` and `error` otherwise. |
| `saveState(slug, writeKey, baseVersion, blob, opts)` | `{status:"saved",version,updatedAt}` or `{status:"conflict",version,blob,updatedAt}`; other responses throw an Error with `status` and `error`. |

`opts` may carry `fetch` and `baseUrl`, which lets a Node test call `worker.fetch` directly.

## Building an encrypted page

```
PAGE_PASSWORD=... node scripts/build-encrypted-page.mjs \
  --shell shell.html --data data.json --out page.html \
  --password-env PAGE_PASSWORD [--state] [--state-from previous.html] [--iter 120000]
```

The password is read only from the named environment variable. The shell must contain `<script id="encrypted-payload" type="application/json"></script>`; the builder fills it with `{"v":1,"iter":..,"salt":..,"iv":..,"ct":..}` (PBKDF2-SHA256, AES-GCM-256, new salt and iv) and fails if the element is missing.

- `--state` writes the `pages-doc-state` marker (replacing the element if present, otherwise inserting it before `</head>`) with a new salt.
- `--state-from <previous published HTML>` reuses the `salt` and `iter` of that file's marker and fails when the password's verifier differs from the marker's. It implies `--state`.
- If the shell has `<script id="pages-doc-state-client"></script>`, the contents of `client/pagesDocState.js` are placed inside it.
- The build fails if any string value of 8 or more characters from the data JSON appears verbatim in the result (plaintext leak check).

Publish the result with the usual upload (`publish.py --doc <slug>`).

**When republishing, pass `--state-from` with the previous published HTML so its marker carries over. Otherwise the new salt changes the verifier, and the next publish clears the server state and raises its version.**
