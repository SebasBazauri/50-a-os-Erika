"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const HTML_FILE = path.join(__dirname, "50 Años de Erika.html");
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, "confirmaciones.json"));
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const GUEST_SESSION_SECONDS = 180 * 24 * 60 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const loginAttempts = new Map();
let writeQueue = Promise.resolve();

if (ADMIN_PASSWORD.length < 12) {
  throw new Error("Configura ADMIN_PASSWORD con al menos 12 caracteres.");
}
if (SESSION_SECRET.length < 32) {
  throw new Error("Configura SESSION_SECRET con al menos 32 caracteres aleatorios.");
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function readCookies(request) {
  const cookies = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return cookies;
}

function signToken(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(encodedPayload).digest("base64url");
  return encodedPayload + "." + signature;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const encodedPayload = token.slice(0, separator);
  const providedSignature = Buffer.from(token.slice(separator + 1));
  const expectedSignature = Buffer.from(crypto.createHmac("sha256", SESSION_SECRET).update(encodedPayload).digest("base64url"));
  if (providedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(providedSignature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function setCookie(response, name, value, maxAge, sameSite) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", name + "=" + encodeURIComponent(value) +
    "; HttpOnly; Path=/; SameSite=" + sameSite + "; Max-Age=" + maxAge + secure);
}

function getGuestId(request, response) {
  const payload = verifyToken(readCookies(request).guest_session);
  if (payload && typeof payload.sub === "string") return payload.sub;
  const guestId = crypto.randomUUID();
  setCookie(response, "guest_session", signToken({ sub: guestId, exp: Date.now() + GUEST_SESSION_SECONDS * 1000 }), GUEST_SESSION_SECONDS, "Lax");
  return guestId;
}

function isAdmin(request) {
  const payload = verifyToken(readCookies(request).admin_session);
  return Boolean(payload && payload.role === "admin");
}

function hasSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of request) {
    byteCount += chunk.length;
    if (byteCount > MAX_BODY_BYTES) {
      const error = new Error("La solicitud es demasiado grande.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("El contenido de la solicitud no es JSON válido.");
    error.status = 400;
    throw error;
  }
}

async function readDatabaseFile() {
  try {
    const content = await fs.readFile(DATA_FILE, "utf8");
    const records = JSON.parse(content || "[]");
    if (!Array.isArray(records)) throw new Error("La base de datos JSON debe contener una lista.");
    return records;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, "[]\n", { flag: "wx" }).catch((writeError) => {
      if (writeError.code !== "EEXIST") throw writeError;
    });
    return [];
  }
}

async function readResponses() {
  await writeQueue;
  return readDatabaseFile();
}

function updateResponses(update) {
  const operation = writeQueue.then(async () => {
    const records = await readDatabaseFile();
    const result = update(records);
    const temporaryFile = DATA_FILE + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(temporaryFile, JSON.stringify(records, null, 2) + "\n", "utf8");
    await fs.rename(temporaryFile, DATA_FILE);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function publicResponse(record) {
  return {
    id: record.id,
    name: record.name,
    attend: record.attend,
    companions: record.companions,
    message: record.message,
    date: record.date
  };
}

function loginAllowed(request) {
  const client = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recentAttempts = (loginAttempts.get(client) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (recentAttempts.length >= 5) return false;
  recentAttempts.push(now);
  loginAttempts.set(client, recentAttempts);
  return true;
}

function clearLoginAttempts(request) {
  loginAttempts.delete(request.socket.remoteAddress || "unknown");
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, "http://localhost");
  const route = requestUrl.pathname;

  if (request.method === "GET" && (route === "/" || route === "/50%20A%C3%B1os%20de%20Erika.html" || decodeURIComponent(route) === "/50 Años de Erika.html")) {
    try {
      const html = await fs.readFile(HTML_FILE);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(html);
    } catch {
      sendJson(response, 500, { error: "No se pudo cargar la invitación." });
    }
    return;
  }

  if (route.startsWith("/api/") && !hasSameOrigin(request)) {
    sendJson(response, 403, { error: "Origen no permitido." });
    return;
  }

  if (request.method === "GET" && route === "/api/rsvp/me") {
    const guestId = getGuestId(request, response);
    const records = await readResponses();
    const record = records.find((item) => item.guestId === guestId);
    sendJson(response, 200, { rsvp: record ? publicResponse(record) : null });
    return;
  }

  if (request.method === "POST" && route === "/api/rsvp") {
    const body = await readJsonBody(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const attend = body.attend;
    const companions = Number(body.companions);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!name || name.length > 120 || !["si", "no"].includes(attend) ||
        !Number.isInteger(companions) || companions < 0 || companions > 10 || message.length > 500) {
      sendJson(response, 400, { error: "Revisa los datos de la confirmación." });
      return;
    }

    const guestId = getGuestId(request, response);
    const savedRecord = await updateResponses((records) => {
      let record = records.find((item) => item.guestId === guestId);
      if (!record) {
        record = { id: crypto.randomUUID(), guestId };
        records.push(record);
      }
      record.name = name;
      record.attend = attend;
      record.companions = attend === "si" ? companions : 0;
      record.message = message;
      record.date = new Date().toISOString();
      return publicResponse(record);
    });
    sendJson(response, 200, { rsvp: savedRecord });
    return;
  }

  if (request.method === "POST" && route === "/api/admin/login") {
    if (!loginAllowed(request)) {
      sendJson(response, 429, { error: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." });
      return;
    }
    const body = await readJsonBody(request);
    const suppliedPassword = typeof body.password === "string" ? body.password : "";
    const expectedHash = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
    const suppliedHash = crypto.createHash("sha256").update(suppliedPassword).digest();
    if (!crypto.timingSafeEqual(expectedHash, suppliedHash)) {
      sendJson(response, 401, { error: "Contraseña incorrecta." });
      return;
    }
    clearLoginAttempts(request);
    setCookie(response, "admin_session", signToken({ role: "admin", exp: Date.now() + ADMIN_SESSION_SECONDS * 1000 }), ADMIN_SESSION_SECONDS, "Strict");
    sendJson(response, 200, { authenticated: true });
    return;
  }

  if (request.method === "GET" && route === "/api/admin/responses") {
    if (!isAdmin(request)) {
      sendJson(response, 401, { error: "Se requiere acceso de organizador." });
      return;
    }
    const records = await readResponses();
    sendJson(response, 200, { responses: records.map(publicResponse) });
    return;
  }

  if (request.method === "POST" && route === "/api/admin/logout") {
    response.setHeader("Set-Cookie", "admin_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0" + (process.env.NODE_ENV === "production" ? "; Secure" : ""));
    sendJson(response, 200, { authenticated: false });
    return;
  }

  sendJson(response, 404, { error: "No encontrado." });
}

async function start() {
  await readDatabaseFile();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) {
        sendJson(response, error.status || 500, { error: error.status ? error.message : "Error interno del servidor." });
      } else {
        response.destroy();
      }
    });
  });
  server.listen(PORT, HOST, () => {
    console.log("Invitación disponible en http://localhost:" + PORT);
    console.log("Respuestas JSON: " + DATA_FILE);
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
