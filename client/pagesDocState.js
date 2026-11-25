// Pages document state reference client. A plain browser script (no import/export):
// inline it into the page and use globalThis.PagesDocState. See docs/document-state.md.
(function () {
  'use strict';

  var MARKER_ID = 'pages-doc-state';
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function stateError(status, error, detail) {
    var err = new Error('document state request failed: ' + status + ' ' + error);
    err.status = status;
    err.error = error;
    err.detail = detail;
    return err;
  }

  // root: a Document or any element/ParentNode that contains the marker (default: globalThis.document).
  function readConfig(root) {
    var scope = root || globalThis.document;
    var element = scope.getElementById ? scope.getElementById(MARKER_ID) : scope.querySelector('#' + MARKER_ID);
    if (!element) return null;
    var config = JSON.parse(element.textContent);
    if (!config || config.v !== 1) throw new Error('unsupported pages-doc-state version');
    return config;
  }

  async function deriveKeys(password, config) {
    var material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    var bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: base64ToBytes(config.salt), iterations: config.iter },
      material,
      512,
    ));
    var encKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    var writeKeyBytes = bits.slice(32, 64);
    var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', writeKeyBytes));
    return {
      encKey: encKey,
      writeKey: bytesToBase64Url(writeKeyBytes),
      verified: bytesToBase64Url(digest) === config.verifier,
    };
  }

  async function encryptState(encKey, value) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      encKey,
      encoder.encode(JSON.stringify(value)),
    ));
    return JSON.stringify({ v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(ct) });
  }

  async function decryptState(encKey, blob) {
    var parsed = JSON.parse(blob);
    if (!parsed || parsed.v !== 1) throw new Error('unsupported state blob version');
    var plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(parsed.iv) },
      encKey,
      base64ToBytes(parsed.ct),
    );
    return JSON.parse(decoder.decode(plain));
  }

  function stateUrl(slug, opts) {
    var base = (opts && opts.baseUrl) || '';
    return base + '/api/documents/' + encodeURIComponent(slug) + '/state';
  }

  function fetcher(opts) {
    return (opts && opts.fetch) || globalThis.fetch.bind(globalThis);
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (err) {
      return {};
    }
  }

  // Resolves {version, blob, updatedAt}; throws an Error with status and error otherwise
  // (status 404 + error "state_not_enabled" means the document has no server state).
  async function fetchState(slug, opts) {
    var response = await fetcher(opts)(stateUrl(slug, opts), { headers: { Accept: 'application/json' } });
    var body = await readJson(response);
    if (response.status !== 200) throw stateError(response.status, body.error || 'unknown_error', body);
    return { version: body.version, blob: body.blob, updatedAt: body.updatedAt };
  }

  async function saveState(slug, writeKey, baseVersion, blob, opts) {
    var response = await fetcher(opts)(stateUrl(slug, opts), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Pages-Write-Key': writeKey },
      body: JSON.stringify({ baseVersion: baseVersion, blob: blob }),
    });
    var body = await readJson(response);
    if (response.status === 200) return { status: 'saved', version: body.version, updatedAt: body.updatedAt };
    if (response.status === 409) {
      return { status: 'conflict', version: body.version, blob: body.blob, updatedAt: body.updatedAt };
    }
    throw stateError(response.status, body.error || 'unknown_error', body);
  }

  globalThis.PagesDocState = {
    readConfig: readConfig,
    deriveKeys: deriveKeys,
    encryptState: encryptState,
    decryptState: decryptState,
    fetchState: fetchState,
    saveState: saveState,
  };
})();
