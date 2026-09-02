// Outbound webhooks: notify a developer's app when a call completes.
//
// Each client can configure one webhook URL (Developer tab or PUT /v1/webhooks).
// We POST a JSON event signed with HMAC-SHA256 over `${timestamp}.${body}` so
// the receiver can verify authenticity and reject replays. Delivery is
// fire-and-forget with a few retries; every attempt is logged for debugging.

import crypto from "node:crypto";

import { getWebhook, recordWebhookDelivery } from "./db.js";

// Header names the receiver checks.
export const SIGNATURE_HEADER = "x-phoneagent-signature";
export const TIMESTAMP_HEADER = "x-phoneagent-timestamp";
export const EVENT_HEADER = "x-phoneagent-event";

const MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 3);
const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 8000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Compute the signature for a payload: HMAC-SHA256 of `${timestamp}.${body}`,
 * hex-encoded and prefixed with the scheme (`sha256=`). Exported so tests and
 * the docs example agree with the server.
 */
export function signPayload(secret, timestamp, body) {
  const mac = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${mac}`;
}

/**
 * Build the event body sent for a completed call. Kept small and stable — the
 * shape a developer integrates against.
 */
export function buildCallCompletedEvent(callRow) {
  return {
    id: `evt_${crypto.randomUUID()}`,
    type: "call.completed",
    created: new Date().toISOString(),
    data: {
      call_id: callRow.call_id,
      status: callRow.status ?? null,
      ended_reason: callRow.ended_reason ?? null,
      outcome: callRow.outcome ?? null,
      callback_time: callRow.callback_time ?? null,
      duration_seconds: callRow.duration_seconds ?? null,
      phone: callRow.customer_number ?? null,
      summary: callRow.summary ?? null,
      batch_id: callRow.batch_id ?? null,
    },
  };
}

async function postOnce(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    return { statusCode: res.status, ok: res.ok, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { statusCode: null, ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver an event to a client's configured webhook, with retries. Resolves
 * (never rejects) so callers can fire-and-forget. No-op when the client has no
 * enabled webhook URL.
 */
export async function deliverEvent(clientId, event) {
  const cfg = getWebhook(clientId);
  if (!cfg || !cfg.enabled || !cfg.url) return { skipped: true };

  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "phone-agent-webhooks/1",
    [EVENT_HEADER]: event.type,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signPayload(cfg.secret, timestamp, body),
  };

  let last = { statusCode: null, ok: false, error: "not attempted" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await postOnce(cfg.url, headers, body);
    if (last.ok) {
      recordWebhookDelivery({
        clientId, event: event.type, url: cfg.url,
        statusCode: last.statusCode, ok: true, error: null, attempts: attempt,
      });
      return { ok: true, attempts: attempt };
    }
    // Exponential-ish backoff between attempts (0.5s, 1.5s, …).
    if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt + 250);
  }
  recordWebhookDelivery({
    clientId, event: event.type, url: cfg.url,
    statusCode: last.statusCode, ok: false, error: last.error, attempts: MAX_ATTEMPTS,
  });
  return { ok: false, attempts: MAX_ATTEMPTS, error: last.error };
}

/**
 * Fire the call.completed event for a saved call row. Fire-and-forget: logs
 * failures but never throws into the webhook request handler.
 */
export function dispatchCallCompleted(callRow) {
  if (!callRow || callRow.client_id == null) return;
  const event = buildCallCompletedEvent(callRow);
  deliverEvent(callRow.client_id, event).catch((err) =>
    console.error("[webhooks] delivery error:", err?.message || err)
  );
}
