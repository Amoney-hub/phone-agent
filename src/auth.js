// Session auth for the dashboard: a single admin user whose username and
// bcrypt password hash come from env (DASHBOARD_USER / DASHBOARD_PASSWORD_HASH).
// Sessions are stateless, HMAC-signed cookies — no store or extra deps needed.

import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const COOKIE_NAME = "pa_session";
// How long a login stays valid.
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

/** Whether dashboard auth is configured (both env vars present). */
export function isAuthConfigured() {
  return Boolean(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASSWORD_HASH);
}

/**
 * Secret used to sign session cookies. Prefer an explicit SESSION_SECRET;
 * otherwise derive from the password hash so that changing the password (or
 * user) invalidates every existing session.
 */
function sessionSecret() {
  const explicit = process.env.SESSION_SECRET;
  if (explicit) return explicit;
  return `${process.env.DASHBOARD_USER || ""}:${process.env.DASHBOARD_PASSWORD_HASH || ""}`;
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function hmac(data) {
  return b64url(crypto.createHmac("sha256", sessionSecret()).update(data).digest());
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a submitted username/password against the configured admin
 * credentials. Returns true only on an exact username match and bcrypt hash
 * match. Async because bcrypt.compare is.
 */
export async function verifyCredentials(username, password) {
  if (!isAuthConfigured()) return false;
  const userOk = safeEqual(String(username ?? ""), process.env.DASHBOARD_USER);
  // Always run bcrypt.compare (even on username mismatch) to avoid leaking
  // which field was wrong via timing.
  let passOk = false;
  try {
    passOk = await bcrypt.compare(
      String(password ?? ""),
      process.env.DASHBOARD_PASSWORD_HASH
    );
  } catch {
    passOk = false;
  }
  return userOk && passOk;
}

/** Create a signed session token for the given username. */
export function createSessionToken(username) {
  const payload = b64url(
    JSON.stringify({ u: username, iat: Math.floor(Date.now() / 1000) })
  );
  return `${payload}.${hmac(payload)}`;
}

/** Validate a session token; returns the payload object or null. */
export function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmac(payload))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  } catch {
    return null;
  }
  if (!data || typeof data.iat !== "number") return null;
  if (Math.floor(Date.now() / 1000) - data.iat > SESSION_TTL_SECONDS) return null;
  return data;
}

/** Parse a Cookie header into a { name: value } object. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Build the Set-Cookie header value for a session (or a clearing) cookie. */
function serializeCookie(value, { maxAge, secure }) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  if (typeof maxAge === "number") parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

function isSecureRequest(req) {
  if (process.env.DASHBOARD_SECURE_COOKIE === "true") return true;
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/** Set the session cookie on the response. */
export function setSessionCookie(req, res, username) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(createSessionToken(username), {
      maxAge: SESSION_TTL_SECONDS,
      secure: isSecureRequest(req),
    })
  );
}

/** Clear the session cookie on the response. */
export function clearSessionCookie(req, res) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie("", { maxAge: 0, secure: isSecureRequest(req) })
  );
}

/** Read and validate the session from a request; returns payload or null. */
export function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

/**
 * Middleware for JSON API routes: requires a valid session, else 401 (or 503
 * when auth is not configured — fail closed).
 */
export function requireAuthApi(req, res, next) {
  if (!isAuthConfigured()) {
    return res.status(503).json({
      error:
        "Dashboard auth is not configured. Set DASHBOARD_USER and DASHBOARD_PASSWORD_HASH.",
    });
  }
  if (getSession(req)) return next();
  return res.status(401).json({ error: "unauthorized" });
}

/**
 * Middleware for HTML page routes: requires a valid session, else redirects to
 * the login page (also when auth is not configured — the login page explains).
 */
export function requireAuthPage(req, res, next) {
  if (isAuthConfigured() && getSession(req)) return next();
  return res.redirect("/login");
}

/**
 * Does the request carry a valid `Authorization: Bearer <TRIGGER_API_KEY>`?
 * Used to let trusted machine clients (the MCP server in remote mode) reach the
 * JSON API without a dashboard session. Returns false when no key is set.
 */
export function hasValidBearer(req) {
  const key = process.env.TRIGGER_API_KEY;
  if (!key) return false;
  const header = (req.get && req.get("authorization")) || req.headers?.authorization || "";
  const m = String(header).match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Middleware for JSON API routes that should be reachable by EITHER a logged-in
 * dashboard session OR a bearer token. Bearer wins first (machine clients);
 * otherwise falls back to the session guard.
 */
export function requireApiAuth(req, res, next) {
  if (hasValidBearer(req)) return next();
  return requireAuthApi(req, res, next);
}
