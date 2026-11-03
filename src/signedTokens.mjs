export function textEncode(value) {
  return new TextEncoder().encode(value);
}

export function textDecode(value) {
  return new TextDecoder().decode(value);
}

function base64Encode(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64Decode(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64Decode(padded);
}

export async function hmacBase64Url(body, secret) {
  const key = await crypto.subtle.importKey("raw", textEncode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncode(body)));
  return base64UrlEncode(signature);
}

export function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function signToken(payload, secret) {
  const payloadText = base64UrlEncode(textEncode(JSON.stringify(payload)));
  return `${payloadText}.${await hmacBase64Url(payloadText, secret)}`;
}

export async function verifyToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payloadText, signature] = parts;
  if (!safeEqual(signature, await hmacBase64Url(payloadText, secret))) return null;
  let payload;
  try {
    payload = JSON.parse(textDecode(base64UrlDecode(payloadText)));
  } catch {
    return null;
  }
  if (!payload || !Number.isInteger(payload.exp)) return null;
  return { payload, expired: payload.exp < now };
}
