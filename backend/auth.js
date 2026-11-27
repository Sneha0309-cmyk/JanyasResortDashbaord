// Minimal, dependency-free session authentication for the dashboard.
//
// - Credentials live ONLY in .env (DASHBOARD_USERNAME, DASHBOARD_PASSWORD_HASH),
//   never in source code. The hash is scrypt$N$r$p$salt$hash (see .env).
// - Sessions are random 256-bit tokens kept in memory for this process.
// - Browser receives an HttpOnly, SameSite=Lax cookie; JavaScript cannot read it.
// - Existing routes and the dashboard page are not modified; this module only
//   decides whether a request is allowed through.
//
// Change the password:  node -e "const c=require('crypto');const s=c.randomBytes(16);const h=c.scryptSync('NEW_PASSWORD',s,64,{N:16384,r:8,p:1});console.log('scrypt$16384$8$1$'+s.toString('base64')+'$'+h.toString('base64'))"
// and paste the output into DASHBOARD_PASSWORD_HASH in .env, then restart.

const crypto = require("crypto");
const path = require("path");

const SESSION_COOKIE = "janyas_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_ATTEMPTS = 10; // per IP per window
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const sessions = new Map(); // token -> { username, expiresAt }
const attempts = new Map(); // ip -> { count, windowStart }

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

setInterval(pruneSessions, 10 * 60 * 1000).unref();

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;

  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

function getSession(req) {
  pruneSessions();
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }

  return { token, ...session };
}

function createSession(username) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function sessionCookie(token, maxAgeMs) {
  const maxAge = Math.floor(maxAgeMs / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function isThrottled(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || now - entry.windowStart > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 0, windowStart: now });
    return false;
  }

  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = attempts.get(ip) || { count: 0, windowStart: Date.now() };
  entry.count += 1;
  attempts.set(ip, entry);
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

function verifyPassword(password) {
  const stored = process.env.DASHBOARD_PASSWORD_HASH || "";
  const parts = stored.split("$");

  if (parts.length !== 6 || parts[0] !== "scrypt") {
    console.error("DASHBOARD_PASSWORD_HASH is missing or invalid in .env");
    return false;
  }

  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n), R = Number(r), P = Number(p);

  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r: R, p: P });
    return crypto.timingSafeEqual(actual, expected);
  } catch (error) {
    console.error("Password verification error:", error.message);
    return false;
  }
}

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// ---------- Middleware ----------

function requireAuthPage(req, res, next) {
  if (getSession(req)) return next();
  return res.redirect("/login");
}

function redirectIfAuthed(req, res, next) {
  if (getSession(req)) return res.redirect("/");
  return next();
}

function requireAuthApi(req, res, next) {
  if (getSession(req)) return next();
  return res.status(401).json({ success: false, message: "Authentication required." });
}

// ---------- Routes ----------

const express = require("express");
const authRouter = express.Router();

authRouter.post("/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  if (isThrottled(ip)) {
    return res.status(429).json({
      success: false,
      message: "Too many login attempts. Please try again in a few minutes."
    });
  }

  const { username, password } = req.body || {};

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username.trim() ||
    !password ||
    username.length > 100 ||
    password.length > 200
  ) {
    return res.status(400).json({
      success: false,
      message: "Please enter your username and password."
    });
  }

  const expectedUser = process.env.DASHBOARD_USERNAME || "";

  let userOk = false;

  try {
    userOk =
      expectedUser.length > 0 &&
      crypto.timingSafeEqual(
        Buffer.from(username.trim().padEnd(256, "\0").slice(0, 256)),
        Buffer.from(expectedUser.padEnd(256, "\0").slice(0, 256))
      );
  } catch {
    userOk = false;
  }

  const passOk = verifyPassword(password);

  if (!userOk || !passOk) {
    recordFailedAttempt(ip);
    return res.status(401).json({
      success: false,
      message: "Invalid username or password."
    });
  }

  clearAttempts(ip);

  const token = createSession(username.trim());

  res.set("Set-Cookie", sessionCookie(token, SESSION_TTL_MS));

  return res.json({ success: true, message: "Login successful." });
});

authRouter.post("/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  destroySession(token);

  res.set("Set-Cookie", sessionCookie("", 0));

  return res.json({ success: true, message: "Logged out." });
});

authRouter.get("/auth-status", (req, res) => {
  const session = getSession(req);

  if (!session) {
    return res.json({ authenticated: false });
  }

  return res.json({ authenticated: true, username: session.username });
});

function serveLoginPage(req, res) {
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
}

function serveDashboardPage(req, res) {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
}

module.exports = {
  authRouter,
  requireAuthPage,
  redirectIfAuthed,
  requireAuthApi,
  serveLoginPage,
  serveDashboardPage
};
