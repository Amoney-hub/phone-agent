// Versioned developer REST API mounted at /v1.
//
// Auth:   Authorization: Bearer <api_key>   (per-client developer keys, the
//         legacy per-client key, or the global TRIGGER_API_KEY → Default client)
// Shape:  resources are flat JSON objects with an `object` field; lists are
//         { object: "list", data: [...] }; errors are
//         { error: { type, code, message, param? } } with a matching status.
// Limits: a per-key sliding-window rate limit with X-RateLimit-* headers.
// Meter:  every request is logged (status + latency) and call/message actions
//         are recorded for /v1/usage.

import crypto from "node:crypto";
import express from "express";

import {
  addContact,
  getContact,
  listContacts,
  getContactById,
  updateContact,
  deleteContact,
  listCalls,
  getStoredCall,
  getBatchCalls,
  getBatch,
  recordMessage,
  getMessage,
  resolveApiKey,
  recordUsage,
  usageSummary,
  getWebhook,
  setWebhook,
  recordRequestLog,
  getDefaultClientId,
} from "./db.js";
import { placeCall, placeBatch } from "./calls.js";
import { sendSms } from "./twilio.js";
import { bearerToken } from "./auth.js";
import { GuardError } from "./guard.js";
import { buildOpenApiSpec } from "./openapi.js";

const RATE_PER_MIN = Number(process.env.V1_RATE_PER_MIN || 120);
const RATE_WINDOW_MS = 60 * 1000;

// --- Standard responses -----------------------------------------------------

const ERROR_TYPE_BY_STATUS = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  409: "conflict_error",
  422: "invalid_request_error",
  429: "rate_limit_error",
  502: "api_error",
  503: "api_error",
};

/** Send a standard error body with the right status + type. */
function sendError(res, status, code, message, param) {
  const body = { error: { type: ERROR_TYPE_BY_STATUS[status] || "api_error", code, message } };
  if (param) body.error.param = param;
  return res.status(status).json(body);
}

/** Map a thrown guard/placement error to a status + code. */
function statusForThrown(err) {
  if (err instanceof GuardError) {
    if (err.code === "classification") return [422, "objective_rejected"];
    if (err.code === "capability") return [403, "capability_denied"];
    if (err.code === "rate") return [429, "rate_limited"];
  }
  if (/^No contact named/.test(err.message)) return [404, "contact_not_found"];
  return [502, "upstream_error"];
}

// --- Serializers ------------------------------------------------------------

function serializeCall(row) {
  if (!row) return null;
  return {
    id: row.call_id,
    object: "call",
    status: row.status ?? null,
    outcome: row.outcome ?? null,
    ended_reason: row.ended_reason ?? null,
    callback_time: row.callback_time ?? null,
    duration_seconds: row.duration_seconds ?? null,
    phone: row.customer_number ?? null,
    contact_name: row.contact_name ?? null,
    summary: row.summary ?? null,
    transcript: row.transcript ?? null,
    // Same proxy the dashboard uses (fresh presigned URL on demand).
    recording_url: row.recording_url
      ? `/api/calls/${encodeURIComponent(row.call_id)}/recording`
      : null,
    batch_id: row.batch_id ?? null,
    created_at: row.placed_at ?? row.updated_at ?? null,
  };
}

function serializeContact(row) {
  if (!row) return null;
  return {
    id: row.id,
    object: "contact",
    name: row.name,
    phone: row.phone,
    created_at: row.created_at,
  };
}

function serializeMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    object: "message",
    to: row.to_number,
    body: row.body,
    status: row.status,
    created_at: row.created_at,
  };
}

// --- Rate limiting (per key, in-memory sliding window) ----------------------

const rateHits = new Map(); // identity -> number[] (timestamps)

function rateCheck(identity, now = Date.now()) {
  let arr = rateHits.get(identity);
  if (!arr) {
    arr = [];
    rateHits.set(identity, arr);
  }
  while (arr.length && now - arr[0] >= RATE_WINDOW_MS) arr.shift();
  if (arr.length >= RATE_PER_MIN) {
    const reset = Math.ceil((arr[0] + RATE_WINDOW_MS - now) / 1000);
    return { ok: false, remaining: 0, reset, limit: RATE_PER_MIN };
  }
  arr.push(now);
  return { ok: true, remaining: RATE_PER_MIN - arr.length, reset: 60, limit: RATE_PER_MIN };
}

/** Test/reset helper. */
export function _resetV1RateLimit() {
  rateHits.clear();
}

// --- Router -----------------------------------------------------------------

export function createV1Router() {
  const router = express.Router();

  // CORS: the API is key-authenticated (no cookies), so a wildcard origin is
  // safe and lets static pages call it directly from the browser. Preflight
  // requests carry no Authorization header, so answer them before auth.
  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Expose-Headers", "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Public: the machine-readable spec (docs are generated from it).
  router.get("/openapi.json", (req, res) => {
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.get("host");
    res.json(buildOpenApiSpec({ baseUrl: host ? `${proto}://${host}` : undefined }));
  });

  // Request logging + usage metering. Attaches a finish listener up front so it
  // captures the final status/latency even for rejected requests.
  router.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const latencyMs = Number((process.hrtime.bigint() - start) / 1000000n);
      try {
        recordRequestLog({
          clientId: req.v1?.clientId ?? null,
          apiKeyId: req.v1?.apiKeyId ?? null,
          method: req.method,
          path: req.baseUrl + (req.path || ""),
          status: res.statusCode,
          latencyMs,
        });
      } catch {
        /* logging must never break a request */
      }
    });
    next();
  });

  // Authenticate: resolve the bearer token to a client. Accepts a developer key
  // (api_keys), the legacy per-client key, or the global TRIGGER_API_KEY.
  router.use((req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      return sendError(res, 401, "missing_api_key", "Provide an API key as `Authorization: Bearer <key>`.");
    }
    const resolved = resolveApiKey(token);
    if (resolved) {
      req.v1 = { clientId: resolved.client_id, apiKeyId: resolved.api_key_id };
      return next();
    }
    // Global admin key → act as the Default client.
    const globalKey = process.env.TRIGGER_API_KEY;
    if (globalKey && token.length === globalKey.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(globalKey))) {
      req.v1 = { clientId: getDefaultClientId(), apiKeyId: null };
      return next();
    }
    return sendError(res, 401, "invalid_api_key", "The API key provided is invalid or revoked.");
  });

  // Per-key rate limit.
  router.use((req, res, next) => {
    const identity = req.v1.apiKeyId != null ? `k:${req.v1.apiKeyId}` : `c:${req.v1.clientId}`;
    const r = rateCheck(identity);
    res.set("X-RateLimit-Limit", String(r.limit));
    res.set("X-RateLimit-Remaining", String(r.remaining));
    res.set("X-RateLimit-Reset", String(r.reset));
    if (!r.ok) {
      res.set("Retry-After", String(r.reset));
      return sendError(res, 429, "rate_limit_exceeded", `Rate limit of ${r.limit} requests/minute exceeded.`);
    }
    next();
  });

  const clientId = (req) => req.v1.clientId;

  // --- Calls ----------------------------------------------------------------

  router.post("/calls", async (req, res) => {
    const body = req.body || {};
    const objective = body.objective;
    if (!objective || !String(objective).trim()) {
      return sendError(res, 400, "missing_field", "objective is required.", "objective");
    }
    // Resolve who to call: a saved contact name, or a phone (optionally with a
    // name) which we upsert into contacts first.
    let contactName = body.contact || body.name || null;
    if (body.phone) {
      const nm = String(body.name || body.contact || body.phone).trim();
      try {
        addContact(nm, String(body.phone).trim(), clientId(req));
      } catch (err) {
        return sendError(res, 400, "invalid_contact", err.message);
      }
      contactName = nm;
    }
    if (!contactName) {
      return sendError(res, 400, "missing_field", "Provide a `contact` name or a `phone`.", "contact");
    }
    try {
      const result = await placeCall({
        name: String(contactName),
        objective: String(objective),
        voicemailMessage: body.voicemail_message,
        clientId: clientId(req),
      });
      if (result && result.needs_info) {
        return sendError(
          res, 422, "objective_incomplete",
          "The objective is missing information the callee will ask for: " + result.missing.join("; ")
        );
      }
      recordUsage({ clientId: clientId(req), apiKeyId: req.v1.apiKeyId, kind: "call" });
      const stored = getStoredCall(result.call_id, clientId(req));
      res.status(201).json(serializeCall(stored) || {
        id: result.call_id, object: "call", status: result.status,
        contact_name: result.contact?.name ?? null, phone: result.contact?.phone ?? null,
      });
    } catch (err) {
      const [status, code] = statusForThrown(err);
      sendError(res, status, code, err.message);
    }
  });

  router.get("/calls", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const all = listCalls(clientId(req));
    const page = all.slice(offset, offset + limit);
    res.json({
      object: "list",
      data: page.map(serializeCall),
      has_more: offset + limit < all.length,
    });
  });

  router.get("/calls/:id", (req, res) => {
    const row = getStoredCall(req.params.id, clientId(req));
    if (!row) return sendError(res, 404, "call_not_found", "No call with that id.");
    // Join the contact name the way listCalls does.
    const calls = listCalls(clientId(req));
    const withName = calls.find((c) => c.call_id === row.call_id) || row;
    res.json(serializeCall(withName));
  });

  // --- Messages -------------------------------------------------------------

  router.post("/messages", async (req, res) => {
    const { to, body } = req.body || {};
    if (!to || !String(to).trim()) return sendError(res, 400, "missing_field", "to is required.", "to");
    if (!body || !String(body).trim()) return sendError(res, 400, "missing_field", "body is required.", "body");
    const id = `msg_${crypto.randomUUID()}`;
    try {
      const sent = await sendSms(String(to).trim(), String(body));
      const row = recordMessage({
        id, clientId: clientId(req), apiKeyId: req.v1.apiKeyId,
        to: sent.to || String(to).trim(), body: String(body),
        status: sent.status || "sent", providerSid: sent.sid || null,
      });
      recordUsage({ clientId: clientId(req), apiKeyId: req.v1.apiKeyId, kind: "message" });
      res.status(201).json(serializeMessage(row));
    } catch (err) {
      // Persist the failure so it shows in history, then report it.
      recordMessage({
        id, clientId: clientId(req), apiKeyId: req.v1.apiKeyId,
        to: String(to).trim(), body: String(body), status: "failed", error: err.message,
      });
      sendError(res, 502, "message_failed", err.message);
    }
  });

  router.get("/messages/:id", (req, res) => {
    const row = getMessage(req.params.id, clientId(req));
    if (!row) return sendError(res, 404, "message_not_found", "No message with that id.");
    res.json(serializeMessage(row));
  });

  // --- Contacts -------------------------------------------------------------

  router.get("/contacts", (req, res) => {
    res.json({ object: "list", data: listContacts(clientId(req)).map(serializeContact) });
  });

  router.post("/contacts", (req, res) => {
    const { name, phone } = req.body || {};
    if (!name || !String(name).trim()) return sendError(res, 400, "missing_field", "name is required.", "name");
    if (!phone || !String(phone).trim()) return sendError(res, 400, "missing_field", "phone is required.", "phone");
    try {
      res.status(201).json(serializeContact(addContact(String(name).trim(), String(phone).trim(), clientId(req))));
    } catch (err) {
      sendError(res, 400, "invalid_contact", err.message);
    }
  });

  router.get("/contacts/:id", (req, res) => {
    const row = getContactById(Number(req.params.id), clientId(req));
    if (!row) return sendError(res, 404, "contact_not_found", "No contact with that id.");
    res.json(serializeContact(row));
  });

  router.put("/contacts/:id", (req, res) => {
    const id = Number(req.params.id);
    const { name, phone } = req.body || {};
    if (!Number.isInteger(id)) return sendError(res, 400, "invalid_id", "invalid id.", "id");
    if (!name || !phone) return sendError(res, 400, "missing_field", "name and phone are required.");
    // Enforce tenant ownership before updating (updateContact isn't scoped).
    if (!getContactById(id, clientId(req))) return sendError(res, 404, "contact_not_found", "No contact with that id.");
    try {
      res.json(serializeContact(updateContact(id, String(name).trim(), String(phone).trim())));
    } catch (err) {
      sendError(res, 409, "contact_conflict", err.message);
    }
  });

  router.delete("/contacts/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return sendError(res, 400, "invalid_id", "invalid id.", "id");
    if (!deleteContact(id, clientId(req))) return sendError(res, 404, "contact_not_found", "No contact with that id.");
    res.json({ id, object: "contact", deleted: true });
  });

  // --- Batches --------------------------------------------------------------

  router.post("/batches", async (req, res) => {
    const { names, objective } = req.body || {};
    if (!Array.isArray(names) || names.length === 0) {
      return sendError(res, 400, "missing_field", "names[] is required.", "names");
    }
    if (!objective || !String(objective).trim()) {
      return sendError(res, 400, "missing_field", "objective is required.", "objective");
    }
    try {
      const result = await placeBatch({
        names: names.map(String),
        objective: String(objective),
        voicemailMessage: req.body.voicemail_message,
        clientId: clientId(req),
      });
      // Count successfully placed calls as usage.
      for (const r of result.results) {
        if (r.call_id) recordUsage({ clientId: clientId(req), apiKeyId: req.v1.apiKeyId, kind: "call" });
      }
      const calls = getBatchCalls(result.batch_id, clientId(req)).map(serializeCall);
      res.status(201).json({
        id: result.batch_id,
        object: "batch",
        objective: String(objective),
        results: result.results,
        calls,
      });
    } catch (err) {
      const [status, code] = statusForThrown(err);
      sendError(res, status, code, err.message);
    }
  });

  router.get("/batches/:id", (req, res) => {
    const batch = getBatch(req.params.id, clientId(req));
    const calls = getBatchCalls(req.params.id, clientId(req)).map(serializeCall);
    if (!batch && calls.length === 0) return sendError(res, 404, "batch_not_found", "No batch with that id.");
    res.json({
      id: req.params.id,
      object: "batch",
      objective: batch?.objective ?? null,
      calls,
    });
  });

  // --- Usage ----------------------------------------------------------------

  const PERIOD_MOD = { day: "-1 day", week: "-7 days", month: "-30 days", all: null };

  router.get("/usage", (req, res) => {
    const period = String(req.query.period || "month");
    if (!(period in PERIOD_MOD)) {
      return sendError(res, 400, "invalid_period", "period must be one of: day, week, month, all.", "period");
    }
    const summary = usageSummary(clientId(req), PERIOD_MOD[period]);
    res.json({ object: "usage", period, ...summary });
  });

  // --- Webhook config -------------------------------------------------------

  router.get("/webhooks", (req, res) => {
    const cfg = getWebhook(clientId(req));
    res.json({
      object: "webhook",
      url: cfg?.url ?? null,
      enabled: cfg ? Boolean(cfg.enabled) : false,
      secret: cfg?.secret ?? null,
    });
  });

  router.put("/webhooks", (req, res) => {
    const { url, enabled, rotate_secret } = req.body || {};
    if (url != null && url !== "" && !/^https?:\/\//i.test(String(url))) {
      return sendError(res, 400, "invalid_url", "url must be an http(s) URL.", "url");
    }
    const cfg = setWebhook(clientId(req), {
      url: url ? String(url) : null,
      enabled: enabled == null ? true : Boolean(enabled),
      rotateSecret: Boolean(rotate_secret),
    });
    res.json({
      object: "webhook",
      url: cfg?.url ?? null,
      enabled: cfg ? Boolean(cfg.enabled) : false,
      secret: cfg?.secret ?? null,
    });
  });

  // Unknown /v1 path.
  router.use((req, res) => sendError(res, 404, "unknown_endpoint", `No such endpoint: ${req.method} ${req.originalUrl}.`));

  return router;
}
