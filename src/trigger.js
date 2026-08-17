// Inbound trigger endpoint: lets external systems start calls via
// POST /api/trigger/call, authenticated by a bearer token (TRIGGER_API_KEY).
// Includes a simple rate limiter and a business-hours guard that can queue or
// reject out-of-hours calls (see src/callhours.js).

import {
  addContact,
  recordPlacedCall,
  enqueueCall,
  listQueuedCalls,
  deleteQueuedCall,
  DEFAULT_CLIENT_ID,
} from "./db.js";
import { createCall } from "./vapi.js";
import { evaluateCallHours, isWithinCallHours, nextWindowOpen } from "./callhours.js";
import { resolveBearer } from "./auth.js";

// --- Auth ------------------------------------------------------------------

/**
 * Require a valid bearer token: either the global TRIGGER_API_KEY (attributes
 * to the Default client) or a client's own api_key (attributes to that client).
 * The resolved principal is attached as `req.principal`.
 */
export function requireTriggerAuth(req, res, next) {
  // The endpoint is only "on" once a global key exists OR clients have keys.
  if (!process.env.TRIGGER_API_KEY) {
    return res
      .status(503)
      .json({ error: "Trigger endpoint disabled. Set TRIGGER_API_KEY to enable it." });
  }
  const principal = resolveBearer(req);
  if (!principal) {
    return res.status(401).json({ error: "Invalid or missing bearer token." });
  }
  req.principal = principal;
  next();
}

// --- Rate limiting ----------------------------------------------------------

// Max accepted triggers per rolling hour (across all sources).
const RATE_MAX = Number(process.env.TRIGGER_RATE_MAX || 30);
const RATE_WINDOW_MS = 60 * 60 * 1000;
const hits = [];

/**
 * Sliding-window rate check. On success records the hit and returns {ok:true};
 * on failure returns {ok:false, retryAfter} (seconds until a slot frees up).
 */
export function checkRateLimit(now = Date.now()) {
  while (hits.length && now - hits[0] >= RATE_WINDOW_MS) hits.shift();
  if (hits.length >= RATE_MAX) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000);
    return { ok: false, retryAfter, limit: RATE_MAX };
  }
  hits.push(now);
  return { ok: true, remaining: RATE_MAX - hits.length, limit: RATE_MAX };
}

/** Test/reset helper. */
export function _resetRateLimit() {
  hits.length = 0;
}

// --- Placing calls ----------------------------------------------------------

/**
 * Upsert the contact, place the call, and record it with its source tag.
 * Shared by the immediate path and the out-of-hours queue drain.
 */
export async function placeTriggeredCall({ name, phone, objective, tag, clientId = DEFAULT_CLIENT_ID }) {
  const sourceTag = tag || "trigger";
  const contact = addContact(name, phone, clientId); // upsert by name within the tenant
  const call = await createCall(contact.phone, objective);
  recordPlacedCall({
    callId: call.id,
    customerNumber: contact.phone,
    status: call.status ?? "queued",
    sourceTag,
    clientId,
  });
  console.error(
    `[trigger] placed call ${call.id} -> ${contact.name} (${contact.phone}) [tag=${sourceTag}] [client=${clientId}]`
  );
  return { call, contact };
}

// --- Queue processing -------------------------------------------------------

/**
 * Place any queued out-of-hours calls, if we are currently within the window.
 * Runs on an interval from the webhook server. Failed placements stay queued
 * to retry on the next tick.
 */
export async function processQueuedCalls() {
  if (!isWithinCallHours()) return { placed: 0 };
  const queued = listQueuedCalls();
  let placed = 0;
  for (const q of queued) {
    if (!isWithinCallHours()) break; // window may close mid-drain
    try {
      await placeTriggeredCall({
        name: q.name,
        phone: q.phone,
        objective: q.objective,
        tag: q.tag,
        clientId: q.client_id ?? DEFAULT_CLIENT_ID,
      });
      deleteQueuedCall(q.id);
      placed++;
    } catch (err) {
      console.error(`[trigger] failed to place queued call #${q.id}:`, err.message);
      // leave it in the queue for the next tick
    }
  }
  if (placed) console.error(`[trigger] drained ${placed} queued call(s) from the out-of-hours queue.`);
  return { placed };
}

// --- Request handler --------------------------------------------------------

/**
 * Handle POST /api/trigger/call. Assumes requireTriggerAuth has already run.
 */
export async function handleTriggerCall(req, res) {
  const body = req.body ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  const tag = body.tag != null && String(body.tag).trim() ? String(body.tag).trim() : null;

  if (!name || !phone || !objective) {
    return res
      .status(400)
      .json({ error: "name, phone, and objective are required." });
  }

  // Attribute to the client whose key was used; the global key falls back to
  // the Default client.
  const clientId = req.principal?.clientId ?? DEFAULT_CLIENT_ID;

  // Rate limit (only spend a slot once the request is otherwise valid).
  const rl = checkRateLimit();
  if (!rl.ok) {
    res.set("Retry-After", String(rl.retryAfter));
    return res.status(429).json({
      error: `Rate limit exceeded (max ${rl.limit}/hour). Try again in ${rl.retryAfter}s.`,
      retry_after: rl.retryAfter,
    });
  }

  // Business-hours guard.
  const hours = evaluateCallHours();
  if (hours.enabled && !hours.within) {
    const mode = String(body.outside_hours || "queue").toLowerCase();
    if (mode === "reject") {
      return res.status(409).json({
        status: "rejected",
        error: `Outside call hours (${hours.spec} ${hours.timezone}).`,
        call_hours: hours.spec,
        timezone: hours.timezone,
      });
    }
    // Default: queue until the window reopens.
    const q = enqueueCall({ name, phone, objective, tag, clientId });
    const scheduledFor = nextWindowOpen();
    console.error(
      `[trigger] queued call to ${name} (${phone}) — outside ${hours.spec} ${hours.timezone} [tag=${tag || "trigger"}] queued_id=${q.id}`
    );
    return res.status(202).json({
      status: "queued",
      queued_id: q.id,
      scheduled_for: scheduledFor,
      call_hours: hours.spec,
      timezone: hours.timezone,
      tag: tag || "trigger",
    });
  }

  // Place immediately.
  try {
    const { call, contact } = await placeTriggeredCall({ name, phone, objective, tag, clientId });
    return res.status(201).json({
      status: "placed",
      call_id: call.id,
      tag: tag || "trigger",
      client_id: clientId,
      contact: { name: contact.name, phone: contact.phone },
    });
  } catch (err) {
    return res.status(502).json({ error: `Failed to place call: ${err.message}` });
  }
}
