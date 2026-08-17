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
  getStoredCall,
  listContacts,
  getContactById,
  updateContact,
  deleteContact,
  listCalls,
  countQueuedCalls,
  listClients,
  createClient,
  getClientById,
  setClientOutcomeValues,
  setClientLogin,
  getDefaultClientId,
  resolveClientId,
  regenerateClientApiKey,
  deleteClient,
  setClientTier,
  listAbuseFlags,
  resolveAbuseFlag,
  countUnresolvedFlags,
  listReviewQueue,
  countReviewQueue,
  setCallReviewStatus,
  addAbuseFlag,
} from "./db.js";
import { tiersView, TIER_NAMES } from "./tiers.js";
import { guardBulkImport, GuardError } from "./guard.js";
import { classifierConfigured } from "./classify.js";
import { renderDashboard, renderLogin, renderClient } from "./dashboard.js";
import { resolveOutcome } from "./vapi.js";
import {
  isAuthConfigured,
  authenticate,
  setSessionCookie,
  clearSessionCookie,
  requireApiAuth,
  requireAdmin,
  getPrincipal,
  resolveScope,
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
import { computeResults } from "./metrics.js";
import bcrypt from "bcryptjs";

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
  const principal = await authenticate(username, password);
  if (!principal) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  setSessionCookie(req, res, principal);
  res.json({ ok: true, role: principal.role });
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

// The dashboard page. Admins get the full admin UI; clients get their
// read-only results view. Both are session-protected.
app.get("/", (req, res) => {
  const p = getPrincipal(req);
  if (!p) return res.redirect("/login");
  res.type("html").send(p.role === "client" ? renderClient() : renderDashboard());
});

const TWILIO_NUMBER_PLACEHOLDER = "+15551234567";

// Optional per-minute cost estimate — admin-only; NEVER exposed to clients.
const COST_PER_MINUTE = Number(process.env.COST_PER_MINUTE || 0);

/**
 * Serialize a call row for a response. Clients get a trimmed, safe view: no
 * source tag, batch id, tenant id, objective, or cost. Admins get the full row
 * plus an estimated per-call cost.
 */
function serializeCall(row, role) {
  const base = {
    call_id: row.call_id,
    contact_name: row.contact_name || null,
    phone: row.customer_number || null,
    status: row.status,
    ended_reason: row.ended_reason,
    outcome: row.outcome,
    callback_time: row.callback_time,
    notes: row.notes,
    summary: row.summary,
    transcript: row.transcript,
    recording_url: row.recording_url,
    duration_seconds: row.duration_seconds,
    updated_at: row.updated_at,
  };
  if (role === "admin") {
    base.batch_id = row.batch_id;
    base.source_tag = row.source_tag;
    base.client_id = row.client_id;
    base.cost =
      COST_PER_MINUTE && row.duration_seconds
        ? Math.round((row.duration_seconds / 60) * COST_PER_MINUTE * 100) / 100
        : null;
  }
  return base;
}

/**
 * Resolve the client to attribute a write to (admin routes only). Priority:
 * an explicit `client` (name or id) in the body, then the `?client_id=` scope
 * (dashboard switcher), then the Default client. Returns `{ id }` or `{ error }`.
 */
function resolveTargetClientId(req) {
  const ref = req.body?.client;
  if (ref != null && String(ref).trim() !== "") {
    const id = resolveClientId(ref);
    return id == null ? { error: `Unknown client "${ref}".` } : { id };
  }
  const { clientId } = resolveScope(req);
  return { id: clientId ?? getDefaultClientId() };
}

// Who am I — drives the UI (role, client, and the admin client switcher list).
app.get("/api/me", (req, res) => {
  const p = getPrincipal(req);
  if (!p) return res.status(401).json({ error: "unauthorized" });
  if (p.role === "client") {
    const client = getClientById(p.clientId);
    // Never expose other tenants or config to a client.
    return res.json({
      role: "client",
      username: p.username,
      client: client ? { id: client.id, name: client.name } : null,
    });
  }
  res.json({
    role: "admin",
    username: p.username,
    clients: listClients(),
    default_client_id: getDefaultClientId(),
    tiers: tiersView(),
    review_count: countReviewQueue(),
    flag_count: countUnresolvedFlags(),
  });
});

// Map a thrown error to an HTTP status. GuardError codes get specific codes;
// a missing contact is 404; anything else from placement is 502.
function statusForError(err) {
  if (err instanceof GuardError) {
    if (err.code === "classification") return 422;
    if (err.code === "capability") return 403;
    if (err.code === "rate") return 429;
  }
  if (/^No contact named/.test(err.message)) return 404;
  return 502;
}

// Report whether the external integrations are configured (admin only).
app.get("/api/status", requireAdmin, (_req, res) => {
  const vapi = Boolean(process.env.VAPI_TOKEN && process.env.VAPI_PHONE_ID);
  const twilio = Boolean(
    process.env.TWILIO_SID &&
      process.env.TWILIO_AUTH &&
      process.env.TWILIO_NUMBER &&
      process.env.TWILIO_NUMBER !== TWILIO_NUMBER_PLACEHOLDER
  );
  res.json({ vapi, twilio });
});

// --- Client management (admin only) ----------------------------------------

app.get("/api/clients", requireAdmin, (_req, res) => res.json(listClients()));

app.post("/api/clients", requireAdmin, (req, res) => {
  const { name, outcome_values } = req.body ?? {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name is required." });
  }
  try {
    res
      .status(201)
      .json(createClient({ name: String(name).trim(), outcomeValues: outcome_values || {} }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Set the per-outcome dollar values used for a client's results header.
app.put("/api/clients/:id/values", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !getClientById(id)) {
    return res.status(404).json({ error: "client not found." });
  }
  const values = req.body?.outcome_values ?? req.body ?? {};
  const clean = {};
  for (const [k, v] of Object.entries(values)) {
    const n = Number(v);
    if (Number.isFinite(n)) clean[k] = n;
  }
  res.json(setClientOutcomeValues(id, clean));
});

// Create/update a client's login (username + password).
app.put("/api/clients/:id/login", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { username, password } = req.body ?? {};
  if (!Number.isInteger(id) || !getClientById(id)) {
    return res.status(404).json({ error: "client not found." });
  }
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required." });
  }
  try {
    const hash = await bcrypt.hash(String(password), 12);
    res.json(setClientLogin(id, String(username).trim(), hash));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rotate a client's trigger API key.
app.post("/api/clients/:id/key", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !getClientById(id)) {
    return res.status(404).json({ error: "client not found." });
  }
  res.json(regenerateClientApiKey(id));
});

// Set a client's account tier (abuse limits).
app.put("/api/clients/:id/tier", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const tier = String(req.body?.tier || "").trim();
  if (!Number.isInteger(id) || !getClientById(id)) {
    return res.status(404).json({ error: "client not found." });
  }
  if (!TIER_NAMES.includes(tier)) {
    return res.status(400).json({ error: `tier must be one of: ${TIER_NAMES.join(", ")}.` });
  }
  res.json(setClientTier(id, tier));
});

// --- Abuse review (admin only) ---------------------------------------------

// New accounts' first calls awaiting review (with transcripts).
app.get("/api/review", requireAdmin, (_req, res) => res.json(listReviewQueue()));

// Approve or flag a reviewed call. Flagging also raises an abuse flag.
app.post("/api/review/:callId", requireAdmin, (req, res) => {
  const callId = String(req.params.callId);
  const status = String(req.body?.status || "").trim(); // "approved" | "flagged"
  if (status !== "approved" && status !== "flagged") {
    return res.status(400).json({ error: 'status must be "approved" or "flagged".' });
  }
  const call = getStoredCall(callId);
  if (!call) return res.status(404).json({ error: "call not found." });
  setCallReviewStatus(callId, status);
  if (status === "flagged") {
    addAbuseFlag({ clientId: call.client_id, kind: "manual_review", detail: callId });
  }
  res.json({ call_id: callId, review_status: status });
});

// Abuse flags raised for accounts.
app.get("/api/flags", requireAdmin, (req, res) => {
  const resolved = req.query.resolved === "1" || req.query.resolved === "true";
  res.json(listAbuseFlags({ resolved }));
});

app.post("/api/flags/:id/resolve", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !resolveAbuseFlag(id)) {
    return res.status(404).json({ error: "flag not found." });
  }
  res.json({ resolved: true });
});

// Delete a client and ALL of its data (contacts, calls, appointments, batches,
// queued calls). The Default client cannot be deleted.
app.delete("/api/clients/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !getClientById(id)) {
    return res.status(404).json({ error: "client not found." });
  }
  try {
    const removed = deleteClient(id);
    if (!removed) return res.status(404).json({ error: "client not found." });
    res.json({ deleted: true });
  } catch (err) {
    // e.g. attempting to delete the Default client.
    res.status(400).json({ error: err.message });
  }
});

// --- Results (admin and clients; always tenant-scoped) ---------------------

app.get("/api/results", (req, res) => {
  const { clientId } = resolveScope(req);
  res.json(computeResults(clientId));
});

// Contacts CRUD — admin only, scoped to the selected client.
app.get("/api/contacts", requireAdmin, (req, res) => {
  const { clientId } = resolveScope(req);
  res.json(listContacts(clientId));
});

app.post("/api/contacts", requireAdmin, (req, res) => {
  const { name, phone } = req.body ?? {};
  if (!name || !phone) {
    return res.status(400).json({ error: "name and phone are required." });
  }
  const target = resolveTargetClientId(req);
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    res.status(201).json(addContact(String(name).trim(), String(phone).trim(), target.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bulk contact import — gated by tier (not available on the cheap tier).
app.post("/api/contacts/bulk", requireAdmin, (req, res) => {
  const rows = req.body?.contacts;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "contacts[] is required." });
  }
  const target = resolveTargetClientId(req);
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    guardBulkImport({ clientId: target.id });
  } catch (err) {
    return res.status(statusForError(err)).json({ error: err.message });
  }
  let added = 0;
  const errors = [];
  for (const r of rows) {
    const name = r && typeof r.name === "string" ? r.name.trim() : "";
    const phone = r && typeof r.phone === "string" ? r.phone.trim() : "";
    if (!name || !phone) { errors.push({ row: r, error: "name and phone required" }); continue; }
    try { addContact(name, phone, target.id); added++; }
    catch (err) { errors.push({ row: r, error: err.message }); }
  }
  res.status(201).json({ added, errors, client_id: target.id });
});

app.put("/api/contacts/:id", requireAdmin, (req, res) => {
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

app.delete("/api/contacts/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid id." });
  }
  if (!deleteContact(id)) return res.status(404).json({ error: "contact not found." });
  res.json({ deleted: true });
});

// Call history, newest first, with resolved contact name. Tenant-scoped and
// serialized per role (admin vs client).
app.get("/api/calls", (req, res) => {
  const { principal, clientId } = resolveScope(req);
  res.json(listCalls(clientId).map((r) => serializeCall(r, principal.role)));
});

// Place a single call to a saved contact (admin only), under the selected client.
app.post("/api/calls", requireAdmin, async (req, res) => {
  const { name, objective, voicemail_message } = req.body ?? {};
  if (!name || !objective) {
    return res.status(400).json({ error: "name and objective are required." });
  }
  const target = resolveTargetClientId(req);
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    const result = await placeCall({
      name: String(name),
      objective: String(objective),
      voicemailMessage: voicemail_message,
      clientId: target.id,
    });
    res.status(201).json({ ...result, client_id: target.id });
  } catch (err) {
    res.status(statusForError(err)).json({ error: err.message });
  }
});

// Place a batch of calls (admin only), under the selected client.
app.post("/api/calls/batch", requireAdmin, async (req, res) => {
  const { names, objective, voicemail_message } = req.body ?? {};
  if (!Array.isArray(names) || names.length === 0 || !objective) {
    return res.status(400).json({ error: "names[] and objective are required." });
  }
  const target = resolveTargetClientId(req);
  if (target.error) return res.status(400).json({ error: target.error });
  try {
    const result = await placeBatch({
      names: names.map(String),
      objective: String(objective),
      voicemailMessage: voicemail_message,
      clientId: target.id,
    });
    res.json({ ...result, client_id: target.id });
  } catch (err) {
    res.status(statusForError(err)).json({ error: err.message });
  }
});

// Fetch all calls in a batch (tenant-scoped). Registered before /api/calls/:id
// so "batch" is not captured as an :id.
app.get("/api/calls/batch/:batchId", (req, res) => {
  const { principal, clientId } = resolveScope(req);
  const calls = getBatchResult(req.params.batchId, clientId).map((r) =>
    serializeCall(r, principal.role)
  );
  res.json({ batch_id: req.params.batchId, calls });
});

// Fetch one call's result (tenant-scoped; stored report, else Vapi for admin).
app.get("/api/calls/:id", async (req, res) => {
  const { clientId } = resolveScope(req);
  try {
    const { source, call } = await getCallResult(req.params.id, clientId);
    res.json({ source, call });
  } catch (err) {
    const notFound = /No call .* found/.test(err.message);
    res.status(notFound ? 404 : 502).json({ error: err.message });
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
  if (classifierConfigured()) {
    console.error("[guard] objective classifier: Anthropic LLM.");
  } else {
    console.error(
      "[guard] objective classifier: heuristic fallback (set ANTHROPIC_API_KEY for LLM classification)."
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
