#!/usr/bin/env node
// Vasudev front door: a real, branded sign-in page for vasudev.tripinstudio.com, replacing
// Caddy's raw HTTP Basic Auth (a bare OS-native credential popup with no product identity).
//
// This process never speaks to a client desk directly. Caddy alone does that (it already
// proxies WebSockets correctly for the Control UI's own RPC connection, which this service
// would otherwise have to reimplement). Caddy's Caddyfile calls this service's `/_auth/check`
// on every request as an internal sub-request (`reverse_proxy` + `handle_response`, the
// pre-2.7 shape of what later Caddy versions call `forward_auth`); a 200 response carries the
// authenticated user's id in `X-Forwarded-User`, which Caddy copies onto the real request
// before routing it — the exact header `gateway.auth.mode: "trusted-proxy"` already expects on
// each desk. `/login` and `/logout` are the only paths a signed-out browser ever reaches.
//
// Sessions are an opaque random id in an HttpOnly cookie, mapped server-side to a username and
// expiry in a small JSON file (same "named JSON state under deploy/desk/" shape as
// `desk-health.json` — this is ops tooling outside the product's own SQLite-only rule, which
// scopes to `src/**`/`extensions/**` state). A stolen cookie is useless without this file.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const PORT = Number(process.env.FRONT_DOOR_PORT ?? 8791);
const USERS_FILE = process.env.FRONT_DOOR_USERS_FILE ?? "/etc/openclaw/front-door/users.json";
const SESSIONS_FILE =
  process.env.FRONT_DOOR_SESSIONS_FILE ?? "/var/lib/openclaw/front-door-sessions.json";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;
const SESSION_COOKIE = "vasudev_session";

/** `{ "<email>": { "hash": "<bcrypt>" } }` — the SAME bcrypt hashes Caddy's basicauth used, so
 *  no client's password changes because of this migration. Re-read on every login attempt
 *  (not cached) so adding/removing a user takes effect without restarting this process. */
function loadUsers() {
  return JSON.parse(readFileSync(USERS_FILE, "utf8"));
}

function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

let sessions = loadSessions();
function saveSessions() {
  mkdirSync("/var/lib/openclaw", { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), { mode: 0o600 });
}
// Drop anything already expired before this process ever serves a request.
for (const [id, session] of Object.entries(sessions)) {
  if (!session.expiresAt || session.expiresAt < Date.now()) {
    delete sessions[id];
  }
}
saveSessions();

/** Internet-facing login endpoint: a simple per-IP window, not a durable security boundary
 *  (this process restarting resets it) — its job is slowing down guesses, not stopping a
 *  determined attacker, which is what the bcrypt cost factor is for. */
const loginAttempts = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now - record.windowStartedAt > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStartedAt: now });
    return false;
  }
  record.count += 1;
  return record.count > RATE_LIMIT_MAX_ATTEMPTS;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function readBody(req, limitBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function renderLoginPage(errorMessage) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in – Vasudev</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f7f7f9; padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) { body { background: #0d0e12; } }
  .card {
    width: min(360px, 100%); padding: 32px 28px; border-radius: 18px; background: #ffffff;
    box-shadow: 0 1px 2px rgba(20,21,26,.05), 0 18px 50px -14px rgba(20,21,26,.12);
  }
  @media (prefers-color-scheme: dark) { .card { background: #16171c; } }
  .orb {
    width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%;
    background: linear-gradient(95deg,#ffc24b 0%,#f97316 16%,#e0218a 38%,#8a2be2 58%,#3a6ff0 78%,#16c79a 100%);
  }
  h1 { font-size: 20px; text-align: center; margin: 0 0 4px; color: #14151a; }
  @media (prefers-color-scheme: dark) { h1 { color: #f2f3f6; } }
  p.sub { text-align: center; color: #585c66; font-size: 13px; margin: 0 0 24px; }
  @media (prefers-color-scheme: dark) { p.sub { color: #a6aab4; } }
  label { display: block; font-size: 13px; color: #585c66; margin: 14px 0 6px; }
  @media (prefers-color-scheme: dark) { label { color: #a6aab4; } }
  input {
    width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #dfdfe6;
    font-size: 14px; background: #ffffff; color: #14151a;
  }
  @media (prefers-color-scheme: dark) {
    input { background: #1d1f26; border-color: #31353f; color: #f2f3f6; }
  }
  button {
    width: 100%; margin-top: 22px; padding: 11px; border: none; border-radius: 10px;
    background: #8a2be2; color: #ffffff; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .err { margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: #fbe9e8; color: #c9302c; font-size: 13px; }
  @media (prefers-color-scheme: dark) { .err { background: #2d1514; color: #f3a9a6; } }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="orb" aria-hidden="true"></div>
    <h1>Sign in to Vasudev</h1>
    <p class="sub">by TripIn Studio</p>
    <label for="username">Email</label>
    <input id="username" name="username" type="email" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    ${errorMessage ? `<div class="err">${escapeHtml(errorMessage)}</div>` : ""}
  </form>
</body>
</html>`;
}

function sessionCookie(sessionId, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://internal");
  // Caddy always sits between this process and the real client (it proxies over loopback), so
  // req.socket.remoteAddress is always 127.0.0.1 — the genuine client IP is in X-Forwarded-For,
  // which Caddy sets from the real connection and which no client can reach this process without
  // passing through. Using the raw socket address here would put every visitor's login attempts
  // in one shared rate-limit bucket, letting one client's typos lock out another's.
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)
    ?.split(",")[0]
    ?.trim() || req.socket.remoteAddress || "unknown";

  // Caddy's internal auth sub-request. It never carries the real client's method or body —
  // only whatever this endpoint returns decides whether the real request proceeds.
  if (url.pathname === "/_auth/check") {
    const cookies = parseCookies(req.headers.cookie);
    const session = cookies[SESSION_COOKIE] ? sessions[cookies[SESSION_COOKIE]] : undefined;
    if (session && session.expiresAt > Date.now()) {
      res.writeHead(200, { "X-Forwarded-User": session.username });
      res.end();
      return;
    }
    res.writeHead(401);
    res.end();
    return;
  }

  if (url.pathname === "/login" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderLoginPage());
    return;
  }

  if (url.pathname === "/login" && req.method === "POST") {
    if (isRateLimited(ip)) {
      res.writeHead(429, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLoginPage("Too many attempts. Wait a few minutes and try again."));
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const params = new URLSearchParams(body);
    const username = (params.get("username") ?? "").trim().toLowerCase();
    const password = params.get("password") ?? "";
    const record = username ? loadUsers()[username] : undefined;
    const ok = record ? await bcrypt.compare(password, record.hash) : false;
    if (!ok) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLoginPage("That email or password is not right."));
      return;
    }
    const sessionId = randomBytes(32).toString("base64url");
    sessions[sessionId] = { username, expiresAt: Date.now() + SESSION_MAX_AGE_MS };
    saveSessions();
    res.writeHead(302, {
      "Set-Cookie": sessionCookie(sessionId, Math.floor(SESSION_MAX_AGE_MS / 1000)),
      Location: "/",
    });
    res.end();
    return;
  }

  if (url.pathname === "/logout") {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE]) {
      delete sessions[cookies[SESSION_COOKIE]];
      saveSessions();
    }
    res.writeHead(302, { "Set-Cookie": sessionCookie("", 0), Location: "/login" });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`vasudev front-door auth listening on 127.0.0.1:${PORT}`);
});
