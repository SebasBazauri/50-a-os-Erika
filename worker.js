"use strict";

const encoder = new TextEncoder();
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const GUEST_SESSION_SECONDS = 180 * 24 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_BODY_BYTES = 16 * 1024;

function jsonResponse(payload, status = 200, cookies = []) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(payload), { status, headers });
}

function readCookies(request) {
  const cookies = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      try {
        cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        continue;
      }
    }
  }
  return cookies;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function signingKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signToken(payload, secret) {
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await signingKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload));
  return encodedPayload + "." + toBase64Url(signature);
}

async function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || !secret) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  try {
    const encodedPayload = token.slice(0, separator);
    const signature = fromBase64Url(token.slice(separator + 1));
    const key = await signingKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(encodedPayload));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload)));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function createCookie(name, value, maxAge, sameSite) {
  return name + "=" + encodeURIComponent(value) +
    "; HttpOnly; Secure; Path=/; SameSite=" + sameSite + "; Max-Age=" + maxAge;
}

async function guestSession(request, env) {
  const payload = await verifyToken(readCookies(request).guest_session, env.SESSION_SECRET);
  if (payload && typeof payload.sub === "string") return { id: payload.sub, cookie: null };
  const id = crypto.randomUUID();
  const token = await signToken({ sub: id, exp: Date.now() + GUEST_SESSION_SECONDS * 1000 }, env.SESSION_SECRET);
  return { id, cookie: createCookie("guest_session", token, GUEST_SESSION_SECONDS, "Lax") };
}

async function isAdmin(request, env) {
  const payload = await verifyToken(readCookies(request).admin_session, env.SESSION_SECRET);
  return Boolean(payload && payload.role === "admin");
}

function hasSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const body = await request.text();
  if (encoder.encode(body).byteLength > MAX_BODY_BYTES) {
    return { error: jsonResponse({ error: "La solicitud es demasiado grande." }, 413) };
  }
  try {
    return { value: JSON.parse(body) };
  } catch {
    return { error: jsonResponse({ error: "El contenido de la solicitud no es JSON válido." }, 400) };
  }
}

async function hashPassword(password) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(password)));
}

function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left[index % left.length] || 0) ^ (right[index % right.length] || 0);
  }
  return difference === 0;
}

async function clientHash(request, secret) {
  const key = await signingKey(secret);
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const hash = await crypto.subtle.sign("HMAC", key, encoder.encode(address));
  return toBase64Url(hash);
}

function publicResponse(record) {
  return {
    id: record.id,
    name: record.name,
    attend: record.attend,
    companions: record.companions,
    message: record.message,
    date: record.updated_at
  };
}

async function saveRsvp(env, guestId, entry) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO rsvps (id, guest_id, name, attend, companions, message, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(guest_id) DO UPDATE SET name = excluded.name, attend = excluded.attend, " +
    "companions = excluded.companions, message = excluded.message, updated_at = excluded.updated_at"
  ).bind(id, guestId, entry.name, entry.attend, entry.attend === "si" ? entry.companions : 0, entry.message, now, now).run();
  return env.DB.prepare(
    "SELECT id, name, attend, companions, message, updated_at FROM rsvps WHERE guest_id = ?"
  ).bind(guestId).first();
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const route = url.pathname;

  if (request.method === "GET" && route === "/api/health") {
    const checks = {
      sessionSecret: Boolean(env.SESSION_SECRET),
      adminPassword: Boolean(env.ADMIN_PASSWORD),
      database: false,
      rsvpTable: false,
      adminTable: false
    };
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      checks.database = true;
      await env.DB.prepare("SELECT COUNT(*) AS total FROM rsvps").first();
      checks.rsvpTable = true;
      await env.DB.prepare("SELECT COUNT(*) AS total FROM admin_login_attempts").first();
      checks.adminTable = true;
    } catch (error) {
      console.error("Health check failed.", error);
    }
    const ready = Object.values(checks).every(Boolean);
    return jsonResponse({ status: ready ? "ok" : "misconfigured", checks }, ready ? 200 : 503);
  }

  if (route.startsWith("/api/") && !hasSameOrigin(request)) {
    return jsonResponse({ error: "Origen no permitido." }, 403);
  }

  if (request.method === "GET" && route === "/api/rsvp/me") {
    if (!env.SESSION_SECRET) {
      return jsonResponse({ error: "Falta configurar SESSION_SECRET en los secrets del Worker." }, 503);
    }
    const guest = await guestSession(request, env);
    const record = await env.DB.prepare(
      "SELECT id, name, attend, companions, message, updated_at FROM rsvps WHERE guest_id = ?"
    ).bind(guest.id).first();
    return jsonResponse({ rsvp: record ? publicResponse(record) : null }, 200, guest.cookie ? [guest.cookie] : []);
  }

  if (request.method === "POST" && route === "/api/rsvp") {
    if (!env.SESSION_SECRET) {
      return jsonResponse({ error: "Falta configurar SESSION_SECRET en los secrets del Worker." }, 503);
    }
    const bodyResult = await readJsonBody(request);
    if (bodyResult.error) return bodyResult.error;
    const body = bodyResult.value;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const attend = body.attend;
    const companions = Number(body.companions);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!name || name.length > 120 || !["si", "no"].includes(attend) ||
        !Number.isInteger(companions) || companions < 0 || companions > 10 || message.length > 500) {
      return jsonResponse({ error: "Revisa los datos de la confirmación." }, 400);
    }
    const guest = await guestSession(request, env);
    const record = await saveRsvp(env, guest.id, { name, attend, companions, message });
    return jsonResponse({ rsvp: publicResponse(record) }, 200, guest.cookie ? [guest.cookie] : []);
  }

  if (request.method === "POST" && route === "/api/admin/login") {
    if (!env.ADMIN_PASSWORD) return jsonResponse({ error: "Falta configurar ADMIN_PASSWORD en los secrets del Worker." }, 503);
    if (!env.SESSION_SECRET) return jsonResponse({ error: "Falta configurar SESSION_SECRET en los secrets del Worker." }, 503);
    const ipHash = await clientHash(request, env.SESSION_SECRET);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("DELETE FROM admin_login_attempts WHERE attempted_at < ?").bind(now - LOGIN_WINDOW_SECONDS).run();
    const attemptCount = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM admin_login_attempts WHERE ip_hash = ? AND attempted_at >= ?"
    ).bind(ipHash, now - LOGIN_WINDOW_SECONDS).first();
    if (attemptCount.total >= MAX_LOGIN_ATTEMPTS) {
      return jsonResponse({ error: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." }, 429);
    }
    const bodyResult = await readJsonBody(request);
    if (bodyResult.error) return bodyResult.error;
    const password = typeof bodyResult.value.password === "string" ? bodyResult.value.password : "";
    const [expected, provided] = await Promise.all([hashPassword(env.ADMIN_PASSWORD), hashPassword(password)]);
    if (!constantTimeEqual(expected, provided)) {
      await env.DB.prepare("INSERT INTO admin_login_attempts (ip_hash, attempted_at) VALUES (?, ?)").bind(ipHash, now).run();
      return jsonResponse({ error: "Contraseña incorrecta." }, 401);
    }
    await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip_hash = ?").bind(ipHash).run();
    const token = await signToken({ role: "admin", exp: Date.now() + ADMIN_SESSION_SECONDS * 1000 }, env.SESSION_SECRET);
    return jsonResponse({ authenticated: true }, 200, [createCookie("admin_session", token, ADMIN_SESSION_SECONDS, "Strict")]);
  }

  if (request.method === "GET" && route === "/api/admin/responses") {
    if (!await isAdmin(request, env)) return jsonResponse({ error: "Se requiere acceso de organizador." }, 401);
    const result = await env.DB.prepare(
      "SELECT id, name, attend, companions, message, updated_at FROM rsvps ORDER BY created_at DESC"
    ).all();
    return jsonResponse({ responses: result.results.map(publicResponse) });
  }

  if (request.method === "POST" && route === "/api/admin/logout") {
    return jsonResponse({ authenticated: false }, 200, ["admin_session=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0"]);
  }

  return jsonResponse({ error: "No encontrado." }, 404);
}

export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname.startsWith("/api/")) {
        return await handleApi(request, env);
      }
      let route;
      try {
        route = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response("No encontrado.", { status: 404 });
      }
      if (request.method === "GET" && ["/", "/index.html", "/50 Años de Erika.html"].includes(route)) {
        return env.ASSETS.fetch(request);
      }
      return new Response("No encontrado.", { status: 404 });
    } catch (error) {
      console.error(error);
      return jsonResponse({ error: "Error interno del servidor." }, 500);
    }
  }
};
