#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";

// `import.meta.dirname` is only on Node 20.11+; fall back so path.join never
// receives undefined on older/hosted runtimes.
const __dirname =
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

// Resolve .env relative to this source file, not the process cwd. In hosted
// environments (e.g. Railway) env vars are injected directly and no .env
// exists; guard so a missing file can never crash at import time.
try {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
} catch {
  /* platform provides env vars; ignore .env load failures */
}

import {
  saveCallReport,
  addContact,
  listContacts,
  getContactById,
  updateContact,
  deleteContact,
  listCalls,
} from "./db.js";
import { renderDashboard, renderLogin } from "./dashboard.js";
import { resolveOutcome } from "./vapi.js";
import {
  isAuthConfigured,
  verifyCredentials,
  setSessionCookie,
  clearSessionCookie,
  requireApiAuth,
  requireAuthPage,
} from "./auth.js";
import {
  placeCall,
  placeBatch,
  getCallResult,
  getBatchResult,
} from "./calls.js";
import {
  requireTriggerAuth,
  handleTriggerCall,
  processQueuedCalls,
} from "./trigger.js";
import { evaluateCallHours } from "./callhours.js";
import { countQueuedCalls } from "./db.js";

// Hosted platforms (Railway, Render, Heroku, …) assign the port via PORT and
// route external traffic to it, so it must take precedence.
const PORT = process.env.PORT || process.env.WEBHOOK_PORT || 3117;

const app = express();
app.use(express.json({ limit: "10mb" }));

// Simple liveness probe. Left open for uptime checks.
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Authentication --------------------------------------------------------

// Login page (open).
app.get("/login", (_req, res) => {
  res.type("html").send(renderLogin());
});

// Verify credentials and set the session cookie.
app.post("/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!isAuthConfigured()) {
    return res.status(503).json({
      error:
        "Dashboard auth is not configured. Set DASHBOARD_USER and DASHBOARD_PASSWORD_HASH (see scripts/hash-password.js).",
    });
  }
  const ok = await verifyCredentials(username, password);
  if (!ok) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  setSessionCookie(req, res, String(username));
  res.json({ ok: true });
});

// Log out: clear the cookie. Accept GET (link) and POST (button/fetch).
function logout(req, res) {
  clearSessionCookie(req, res);
  if (req.method === "POST") return res.json({ ok: true });
  res.redirect("/login");
}
app.get("/logout", logout);
app.post("/logout", logout);

// --- Inbound trigger (bearer-token auth, NOT session) ----------------------

// Registered before the session guard so it authenticates with its own bearer
// token instead of a dashboard cookie. Lets external systems start calls.
app.post("/api/trigger/call", requireTriggerAuth, handleTriggerCall);

// --- Dashboard + JSON API --------------------------------------------------

// Everything else under /api requires either a dashboard session OR the bearer
// token (the latter is how the MCP server talks to this API in remote mode).
app.use("/api", requireApiAuth);

// Single self-contained dashboard page (session-protected).
app.get("/", requireAuthPage, (_req, res) => {
  res.type("html").send(renderDashboard());
});

const TWILIO_NUMBER_PLACEHOLDER = "+15551234567";

// Report whether the external integrations are configured.
app.get("/api/status", (_req, res) => {
  const vapi = Boolean(process.env.VAPI_TOKEN && process.env.VAPI_PHONE_ID);
  const twilio = Boolean(
    process.env.TWILIO_SID &&
      process.env.TWILIO_AUTH &&
      process.env.TWILIO_NUMBER &&
      process.env.TWILIO_NUMBER !== TWILIO_NUMBER_PLACEHOLDER
  );
  res.json({ vapi, twilio });
});

// Contacts CRUD.
app.get("/api/contacts", (_req, res) => {
  res.json(listContacts());
});

app.post("/api/contacts", (req, res) => {
  const { name, phone } = req.body ?? {};
  if (!name || !phone) {
    return res.status(400).json({ error: "name and phone are required." });
  }
  try {
    res.status(201).json(addContact(String(name).trim(), String(phone).trim()));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/contacts/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, phone } = req.body ?? {};
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid id." });
  }
  if (!name || !phone) {
    return res.status(400).json({ error: "name and phone are required." });
  }
  if (!getContactById(id)) {
    return res.status(404).json({ error: "contact not found." });
  }
  try {
    res.json(updateContact(id, String(name).trim(), String(phone).trim()));
  } catch (err) {
    // Most likely a UNIQUE name collision.
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/contacts/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid id." });
  }
  const removed = deleteContact(id);
  if (!removed) return res.status(404).json({ error: "contact not found." });
  res.json({ deleted: true });
});

// Call history, newest first, with resolved contact name.
app.get("/api/calls", (_req, res) => {
  res.json(listCalls());
});

// Place a single call to a saved contact.
app.post("/api/calls", async (req, res) => {
  const { name, objective, voicemail_message } = req.body ?? {};
  if (!name || !objective) {
    return res.status(400).json({ error: "name and objective are required." });
  }
  try {
    const result = await placeCall({
      name: String(name),
      objective: String(objective),
      voicemailMessage: voicemail_message,
    });
    res.status(201).json(result);
  } catch (err) {
    // A missing contact is a 404; anything else (Vapi failure) is a 502.
    const notFound = /^No contact named/.test(err.message);
    res.status(notFound ? 404 : 502).json({ error: err.message });
  }
});

// Place a batch of calls to several saved contacts, staggered.
app.post("/api/calls/batch", async (req, res) => {
  const { names, objective, voicemail_message } = req.body ?? {};
  if (!Array.isArray(names) || names.length === 0 || !objective) {
    return res.status(400).json({ error: "names[] and objective are required." });
  }
  try {
    const result = await placeBatch({
      names: names.map(String),
      objective: String(objective),
      voicemailMessage: voicemail_message,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Fetch all calls in a batch. Registered before /api/calls/:id so "batch" is
// not captured as an :id.
app.get("/api/calls/batch/:batchId", (req, res) => {
  res.json({ batch_id: req.params.batchId, calls: getBatchResult(req.params.batchId) });
});

// Fetch one call's result (stored webhook report, else the Vapi API).
app.get("/api/calls/:id", async (req, res) => {
  try {
    const { source, call } = await getCallResult(req.params.id);
    res.json({ source, call });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Normalize a Vapi end-of-call-report message into our stored shape.
 * Vapi has moved fields around over API versions, so we check the common
 * locations (top-level, `artifact`, and `analysis`).
 */
function normalizeReport(message) {
  const call = message.call ?? {};
  const artifact = message.artifact ?? {};
  const analysis = message.analysis ?? {};

  // Duration: prefer explicit seconds, then ms, then compute from timestamps.
  let durationSeconds = null;
  if (typeof message.durationSeconds === "number") {
    durationSeconds = Math.round(message.durationSeconds);
  } else if (typeof message.durationMs === "number") {
    durationSeconds = Math.round(message.durationMs / 1000);
  } else if (message.startedAt && message.endedAt) {
    const diff =
      (new Date(message.endedAt).getTime() -
        new Date(message.startedAt).getTime()) /
      1000;
    if (Number.isFinite(diff) && diff >= 0) durationSeconds = Math.round(diff);
  }

  // Structured outcome from the assistant's analysis plan (see vapi.js).
  const structured = analysis.structuredData ?? {};
  const endedReason = message.endedReason ?? call.endedReason ?? null;

  return {
    callId: call.id ?? message.callId ?? null,
    status: message.status ?? call.status ?? "ended",
    endedReason,
    summary: analysis.summary ?? message.summary ?? null,
    transcript: artifact.transcript ?? message.transcript ?? null,
    recordingUrl:
      message.recordingUrl ??
      artifact.recordingUrl ??
      artifact.recording?.url ??
      null,
    customerNumber:
      message.customer?.number ?? call.customer?.number ?? null,
    durationSeconds,
    // A voicemail ended-reason is authoritative over the LLM's guess.
    outcome: resolveOutcome(structured.outcome, endedReason),
    // Vapi returns "" for absent optional strings; store null instead.
    callbackTime: structured.callback_time || null,
    notes: structured.notes || null,
  };
}

// Header Vapi is told to send (see vapi.js `createCall`). Its value must match
// VAPI_WEBHOOK_SECRET for the request to be accepted.
const VAPI_SECRET_HEADER = "x-vapi-secret";

/**
 * Verify the shared-secret header on an incoming webhook. Returns true when the
 * request is allowed. When no secret is configured, allow all (legacy behavior)
 * but that is warned about at startup.
 */
function webhookSecretOk(req) {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) return true; // not configured — do not enforce
  const got = req.get(VAPI_SECRET_HEADER) || "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The webhook stays OUTSIDE the session auth (Vapi has no cookie); instead it
// is verified with the shared secret header.
app.post("/vapi/webhook", (req, res) => {
  if (!webhookSecretOk(req)) {
    console.error("[webhook] rejected request with missing/invalid secret.");
    return res.status(401).json({ error: "invalid webhook secret" });
  }

  const message = req.body?.message;
  if (!message || typeof message !== "object") {
    return res.status(400).json({ error: "Missing Vapi `message` in body." });
  }

  if (message.type === "end-of-call-report") {
    const report = normalizeReport(message);
    if (!report.callId) {
      console.error("[webhook] end-of-call-report missing call id; skipping.");
    } else {
      try {
        saveCallReport(report);
        console.error(
          `[webhook] saved end-of-call-report for call ${report.callId} (${report.endedReason ?? report.status}).`
        );
      } catch (err) {
        console.error("[webhook] failed to save report:", err);
      }
    }
  }

  // Always ack with 200 so Vapi does not retry indefinitely.
  res.json({ received: true });
});

app.listen(PORT, () => {
  console.error(
    `phone-agent webhook listening on http://localhost:${PORT}/vapi/webhook`
  );
  if (!isAuthConfigured()) {
    console.error(
      "[auth] WARNING: dashboard auth not configured — the dashboard and /api are locked until you set DASHBOARD_USER and DASHBOARD_PASSWORD_HASH (see scripts/hash-password.js)."
    );
  }
  if (!process.env.VAPI_WEBHOOK_SECRET) {
    console.error(
      "[auth] WARNING: VAPI_WEBHOOK_SECRET not set — /vapi/webhook accepts unauthenticated requests. Set it to verify Vapi callbacks."
    );
  }
  if (!process.env.TRIGGER_API_KEY) {
    console.error(
      "[trigger] TRIGGER_API_KEY not set — POST /api/trigger/call is disabled (503). Set it to enable inbound call triggers."
    );
  } else {
    const hours = evaluateCallHours();
    console.error(
      `[trigger] inbound call trigger enabled at POST /api/trigger/call` +
        (hours.enabled
          ? ` (call hours ${hours.spec} ${hours.timezone}).`
          : " (no call-hours guard; set CALL_HOURS to restrict).")
    );
  }
});

// Drain the out-of-hours queue every minute when within the call window.
const QUEUE_TICK_MS = 60 * 1000;
const queueTimer = setInterval(() => {
  processQueuedCalls().catch((err) =>
    console.error("[trigger] queue processing error:", err.message)
  );
}, QUEUE_TICK_MS);
// Don't keep the event loop alive solely for this timer.
queueTimer.unref?.();

// Log any pending queued calls at startup so restarts are transparent.
try {
  const pending = countQueuedCalls();
  if (pending > 0) {
    console.error(`[trigger] ${pending} call(s) waiting in the out-of-hours queue.`);
  }
} catch {
  /* table may not exist yet on a brand-new DB race; ignore */
}
