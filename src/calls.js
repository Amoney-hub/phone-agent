// Shared call operations backed by local SQLite + Vapi. Used by both the HTTP
// server (src/webhook.js) and the MCP server's local mode (src/index.js), so
// the two never drift apart. Returns plain snake_case objects ready for JSON.

import crypto from "node:crypto";

import {
  getContact,
  recordPlacedCall,
  getStoredCall,
  getBatchCalls,
  recordBatch,
  DEFAULT_CLIENT_ID,
} from "./db.js";
import { createCall, getCall } from "./vapi.js";
import {
  guardObjectiveAndCapability,
  guardRate,
  reviewStatusFor,
  runAbuseDetection,
} from "./guard.js";
import { checkObjectiveRequirements } from "./requirements.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Seconds between successive dials in a batch, to avoid hammering the provider
// and to space out simultaneous ringing.
export const BATCH_STAGGER_MS = 3000;

function resolveContact(name, clientId) {
  const contact = getContact(name, clientId);
  if (!contact) {
    throw new Error(`No contact named "${name}". Add one first with add_contact.`);
  }
  return contact;
}

/**
 * Place a single call to a saved contact within a tenant.
 * @returns {{call_id: string, status: string, contact: {name: string, phone: string}}}
 */
export async function placeCall({ name, objective, voicemailMessage, clientId = DEFAULT_CLIENT_ID }) {
  const contact = resolveContact(name, clientId);
  // Abuse guard: capability + objective classification.
  const { objectiveNorm } = await guardObjectiveAndCapability({ clientId, objective, kind: "single" });

  // Pre-call requirement check: don't dial if the objective is missing details
  // the callee will predictably ask for — return the questions instead.
  const req = await checkObjectiveRequirements(objective);
  if (!req.complete) {
    return { needs_info: true, missing: req.missing };
  }

  guardRate({ clientId, phone: contact.phone });
  const reviewStatus = reviewStatusFor(clientId);

  const call = await createCall(contact.phone, objective, { voicemailMessage });
  recordPlacedCall({
    callId: call.id,
    customerNumber: contact.phone,
    status: call.status ?? "queued",
    clientId,
    objective,
    objectiveNorm,
    reviewStatus,
  });
  runAbuseDetection(clientId);
  return {
    call_id: call.id,
    status: call.status ?? "queued",
    contact: { name: contact.name, phone: contact.phone },
  };
}

/**
 * Place calls to several saved contacts with the same objective, staggered a
 * few seconds apart. Per-contact failures are captured as `error` on the row
 * rather than aborting the batch.
 * @returns {{batch_id: string, results: Array<object>}}
 */
export async function placeBatch({
  names,
  objective,
  voicemailMessage,
  batchId,
  clientId = DEFAULT_CLIENT_ID,
}) {
  // Capability (batch allowed on this tier?) + objective classification once,
  // up front — a rejection fails the whole batch with a clear error.
  const { objectiveNorm } = await guardObjectiveAndCapability({ clientId, objective, kind: "batch" });

  const batch_id = batchId || `batch_${crypto.randomUUID()}`;
  recordBatch({ batchId: batch_id, clientId, objective });
  const results = [];
  for (let i = 0; i < names.length; i++) {
    if (i > 0) await sleep(BATCH_STAGGER_MS);
    const name = names[i];
    try {
      const contact = resolveContact(name, clientId);
      // Per-call rate check so the batch stops once the day/week caps are hit.
      guardRate({ clientId, phone: contact.phone });
      const reviewStatus = reviewStatusFor(clientId);
      const call = await createCall(contact.phone, objective, { voicemailMessage });
      recordPlacedCall({
        callId: call.id,
        batchId: batch_id,
        customerNumber: contact.phone,
        status: call.status ?? "queued",
        clientId,
        objective,
        objectiveNorm,
        reviewStatus,
      });
      results.push({
        name: contact.name,
        phone: contact.phone,
        call_id: call.id,
        status: call.status ?? "queued",
        error: null,
      });
    } catch (err) {
      results.push({ name, phone: null, call_id: null, status: null, error: err.message });
    }
  }
  runAbuseDetection(clientId);
  return { batch_id, results };
}

/**
 * Fetch one call's result: the locally stored webhook report if present
 * (instant), otherwise the Vapi API. Returns a normalized snake_case object.
 * @returns {Promise<{source: "webhook"|"api", call: object}>}
 */
export async function getCallResult(callId, clientId = null) {
  const stored = getStoredCall(callId, clientId);
  if (stored) {
    return {
      source: "webhook",
      call: {
        call_id: stored.call_id,
        status: stored.status,
        ended_reason: stored.ended_reason,
        summary: stored.summary,
        transcript: stored.transcript,
        recording_url: stored.recording_url,
        outcome: stored.outcome,
        callback_time: stored.callback_time,
        notes: stored.notes,
        batch_id: stored.batch_id,
      },
    };
  }
  // Not stored yet. Only fall back to the Vapi API for unscoped (admin)
  // lookups — a tenant-scoped miss must not leak another client's call.
  if (clientId != null) {
    throw new Error(`No call ${callId} found.`);
  }
  const call = await getCall(callId); // Vapi client returns camelCase
  return {
    source: "api",
    call: {
      call_id: call.id,
      status: call.status,
      ended_reason: call.endedReason,
      summary: call.summary,
      transcript: call.transcript,
      recording_url: call.recordingUrl,
      outcome: call.outcome,
      callback_time: call.callbackTime,
      notes: call.notes,
      batch_id: null,
    },
  };
}

/**
 * Fetch all calls in a batch (rows include the resolved `contact_name`).
 * @returns {Array<object>}
 */
export function getBatchResult(batchId, clientId = null) {
  return getBatchCalls(batchId, clientId);
}
