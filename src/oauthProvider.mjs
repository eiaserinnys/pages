import { base64UrlEncode, signToken, textEncode, verifyToken } from "./signedTokens.mjs";

const DAY_SECONDS = 24 * 60 * 60;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function issuer(env) {
  return env.BASE_URL.replace(/\/+$/, "");
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function noStoreJson(body, status = 200) {
  return json(body, status, { "Cache-Control": "no-store" });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function allowedEmails(env) {
  return env.ALLOWED_EMAILS.split(",").map((value) => value.trim()).filter(Boolean);
}

function isLoopbackRedirectUri(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "http:"
      && !url.username
      && !url.password
      && !url.hash
      && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function oauthErrorRedirect(redirectUri, error, state) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("state", state);
  return url.toString();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function oauthDiscovery(env) {
  const root = issuer(env);
  return json({
    issuer: root,
    authorization_endpoint: `${root}/auth/oauth/authorize`,
    token_endpoint: `${root}/auth/oauth/token`,
    registration_endpoint: `${root}/auth/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });
}

export async function registerOAuthClient(request, env) {
  const body = await readJson(request);
  const redirectUris = body?.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0
    || !redirectUris.every((uri) => typeof uri === "string" && isLoopbackRedirectUri(uri))) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }
  if ((body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none")
    || (body.client_name !== undefined && typeof body.client_name !== "string")) {
    return json({ error: "invalid_client_metadata" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const clientName = body.client_name;
  const clientId = await signToken({
    typ: "pages.oauth_client",
    redirect_uris: redirectUris,
    ...(clientName === undefined ? {} : { client_name: clientName }),
    iat: now,
    exp: now + 365 * DAY_SECONDS,
  }, env.SESSION_SECRET);
  return json({
    client_id: clientId,
    ...(clientName === undefined ? {} : { client_name: clientName }),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201);
}

async function readClient(clientId, env) {
  const result = await verifyToken(clientId, env.SESSION_SECRET);
  if (!result || result.expired || result.payload.typ !== "pages.oauth_client"
    || !Array.isArray(result.payload.redirect_uris)) return null;
  return result.payload;
}

async function sha256Base64Url(value) {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncode(value))));
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function authorizeOAuthClient(request, env, getSession) {
  const url = new URL(request.url);
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!redirectUri || !isLoopbackRedirectUri(redirectUri)) return json({ error: "invalid_redirect_uri" }, 400);
  const state = url.searchParams.get("state");
  if (!state) return json({ error: "invalid_request" }, 400);

  const clientPayload = await readClient(url.searchParams.get("client_id"), env);
  if (!clientPayload) return redirect(oauthErrorRedirect(redirectUri, "invalid_client", state));
  if (!clientPayload.redirect_uris.includes(redirectUri)) return json({ error: "invalid_redirect_uri" }, 400);

  const responseType = url.searchParams.get("response_type");
  const codeChallenge = url.searchParams.get("code_challenge");
  const method = url.searchParams.get("code_challenge_method");
  if (responseType !== "code" || !codeChallenge || method !== "S256") {
    return redirect(oauthErrorRedirect(redirectUri, "invalid_request", state));
  }

  const session = await getSession(request, env);
  if (!session) {
    const returnTo = `${url.pathname}${url.search}`;
    return redirect(`/auth/google?returnTo=${encodeURIComponent(returnTo)}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const code = await signToken({
    typ: "pages.oauth_code",
    jti: randomHex(16),
    cid: await sha256Base64Url(url.searchParams.get("client_id")),
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    email: session.email,
    name: session.name || session.email,
    exp: now + 300,
  }, env.SESSION_SECRET);
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  return redirect(callback.toString());
}

async function consumeAuthorizationCode(env, payload, now) {
  await env.PAGES_DB.prepare("DELETE FROM oauth_used_codes WHERE expires_at < ?").bind(now).run();
  try {
    await env.PAGES_DB.prepare("INSERT INTO oauth_used_codes (jti, expires_at) VALUES (?, ?)")
      .bind(payload.jti, payload.exp).run();
    return true;
  } catch (error) {
    if (String(error?.message || error).includes("oauth_used_codes.jti")) return false;
    throw error;
  }
}

function formValue(form, name) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function invalidGrant() {
  return noStoreJson({ error: "invalid_grant" }, 400);
}

export async function exchangeOAuthToken(request, env) {
  const form = new URLSearchParams(await request.text());
  const grantType = formValue(form, "grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return noStoreJson({ error: "unsupported_grant_type" }, 400);
  }

  const clientId = formValue(form, "client_id");
  if (!clientId) return noStoreJson({ error: "invalid_request" }, 400);
  const client = await readClient(clientId, env);
  if (!client) return noStoreJson({ error: "invalid_client" }, 400);
  const cid = await sha256Base64Url(clientId);
  let payload;

  if (grantType === "authorization_code") {
    const code = formValue(form, "code");
    const redirectUri = formValue(form, "redirect_uri");
    const verifier = formValue(form, "code_verifier");
    if (!code || !redirectUri || !verifier) return noStoreJson({ error: "invalid_request" }, 400);
    const codeResult = await verifyToken(code, env.SESSION_SECRET);
    if (!codeResult || codeResult.expired || codeResult.payload.typ !== "pages.oauth_code"
      || codeResult.payload.cid !== cid
      || codeResult.payload.redirect_uri !== redirectUri
      || await sha256Base64Url(verifier) !== codeResult.payload.code_challenge) return invalidGrant();
    if (!(await consumeAuthorizationCode(env, codeResult.payload, Math.floor(Date.now() / 1000)))) return invalidGrant();
    payload = codeResult.payload;
  } else {
    const refreshToken = formValue(form, "refresh_token");
    if (!refreshToken) return invalidGrant();
    const refresh = await verifyToken(refreshToken, env.SESSION_SECRET);
    if (!refresh || refresh.expired || refresh.payload.typ !== "pages.oauth_refresh" || refresh.payload.cid !== cid) return invalidGrant();
    payload = refresh.payload;
  }

  if (typeof payload.email !== "string" || !allowedEmails(env).includes(payload.email)) return invalidGrant();
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signToken({
    typ: "pages.oauth_access",
    email: payload.email,
    name: payload.name || payload.email,
    exp: now + 3600,
  }, env.SESSION_SECRET);
  const nextRefreshToken = await signToken({
    typ: "pages.oauth_refresh",
    cid,
    email: payload.email,
    name: payload.name || payload.email,
    exp: now + 30 * DAY_SECONDS,
  }, env.SESSION_SECRET);
  return noStoreJson({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: nextRefreshToken });
}

export async function verifyOAuthAccessToken(token, env) {
  const result = await verifyToken(token, env.SESSION_SECRET);
  if (!result || result.expired || result.payload.typ !== "pages.oauth_access"
    || typeof result.payload.email !== "string" || !allowedEmails(env).includes(result.payload.email)) return null;
  return { email: result.payload.email, name: result.payload.name || result.payload.email };
}

export async function createViewToken(revId, env) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ typ: "pages.view", rev: revId, exp: now + 7 * DAY_SECONDS }, env.SESSION_SECRET);
}

export async function verifyViewToken(token, env) {
  const result = await verifyToken(token, env.SESSION_SECRET);
  if (!result || result.payload.typ !== "pages.view" || !/^[0-9a-f]{12}$/.test(result.payload.rev || "")) return null;
  return { rev: result.payload.rev, expired: result.expired };
}
