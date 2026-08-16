// Minimal Vapi client for placing outbound calls with a transient assistant
// and fetching call results. Uses the Vapi REST API and global fetch (Node 18+).

const VAPI_BASE = "https://api.vapi.ai";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Build a system prompt for the transient assistant from a plain-language
 * objective supplied by the caller.
 */
export function buildSystemPrompt(objective) {
  return [
    "You are an AI voice assistant making an outbound phone call on behalf of your user (the person who owns this phone agent).",
    "",
    "ALWAYS open the call the same way: first identify yourself as an AI assistant calling on behalf of your user, and then immediately get to the point of why you are calling. Do not make small talk before disclosing that you are an AI.",
    "Speak naturally and conversationally, keep your turns short, and be polite.",
    "",
    "Your objective for this call:",
    objective,
    "",
    "Guidelines:",
    "- Your very first turn must disclose that you are an AI assistant calling on behalf of your user, then briefly state the reason for the call.",
    "- Stay focused on the objective and gather or convey the needed information.",
    "- If you reach voicemail, leave a concise message that identifies you as an AI assistant calling on behalf of your user and covers the objective.",
    "- Once the objective is met, thank the person and end the call.",
  ].join("\n");
}

/**
 * Build the short message the assistant leaves if the call reaches voicemail
 * instead of a live person, derived from the objective.
 */
export function buildVoicemailMessage(objective) {
  return [
    "Hi, this is an AI assistant calling on behalf of my user.",
    `I'm calling about: ${objective}.`,
    "Sorry to miss you — please call us back when you get a chance. Thank you!",
  ].join(" ");
}

/**
 * Voicemail-detection config for the transient assistant. Uses Vapi's built-in
 * detector, which needs no extra provider credentials. When it fires, the
 * assistant speaks `voicemailMessage` and ends the call.
 */
export function buildVoicemailDetection() {
  return { provider: "vapi" };
}

/**
 * Reconcile the LLM-extracted outcome with the call's ended reason. If the call
 * ended because it hit voicemail, that signal is authoritative — tag it
 * `voicemail` regardless of what the structured-data model guessed.
 */
export function resolveOutcome(structuredOutcome, endedReason) {
  if (endedReason && /voicemail/i.test(endedReason)) return "voicemail";
  return structuredOutcome || null;
}

// Allowed values for the structured `outcome` field. Kept here so the schema
// (sent to Vapi) and any consumers stay in sync.
export const CALL_OUTCOMES = [
  "reached",
  "voicemail",
  "not_interested",
  "interested",
  "booked",
  "callback_requested",
];

/**
 * Analysis plan asking Vapi to extract a structured summary of the call once
 * it ends. The result is delivered on the end-of-call-report webhook at
 * `message.analysis.structuredData`.
 */
export function buildAnalysisPlan() {
  return {
    structuredDataPlan: {
      enabled: true,
      schema: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            enum: CALL_OUTCOMES,
            description:
              "The single best-fitting outcome of the call: " +
              "'reached' (spoke to the person but none of the more specific outcomes apply), " +
              "'voicemail' (reached voicemail / no live person), " +
              "'not_interested' (person declined or was not interested), " +
              "'interested' (person expressed interest but nothing was booked), " +
              "'booked' (an appointment, reservation, or commitment was made), " +
              "'callback_requested' (person asked to be called back later).",
          },
          callback_time: {
            type: "string",
            description:
              "If the person requested a callback or gave a specific time, the time/date they mentioned (verbatim or ISO-ish). Empty string if none.",
          },
          notes: {
            type: "string",
            description:
              "A one or two sentence note capturing any important detail worth remembering. Empty string if none.",
          },
        },
        required: ["outcome"],
      },
    },
  };
}

/**
 * Create an outbound call with a transient (inline) assistant.
 * @param {string} to        Destination number in E.164 format.
 * @param {string} objective Plain-language goal for the call.
 * @param {object} [options]
 * @param {string} [options.voicemailMessage] Override for the message left on
 *   voicemail. Defaults to one generated from the objective.
 * @returns {Promise<object>} The created call object (includes `id`).
 */
export async function createCall(to, objective, options = {}) {
  const token = requireEnv("VAPI_TOKEN");
  const phoneNumberId = requireEnv("VAPI_PHONE_ID");

  const voicemailMessage =
    options.voicemailMessage?.trim() || buildVoicemailMessage(objective);

  const payload = {
    phoneNumberId,
    customer: { number: to },
    assistant: {
      firstMessage:
        "Hi, this is an AI assistant calling on behalf of my user. Do you have a moment?",
      model: {
        provider: "openai",
        model: "gpt-4o",
        messages: [{ role: "system", content: buildSystemPrompt(objective) }],
      },
      voice: { provider: "vapi", voiceId: "Elliot" },
      transcriber: { provider: "deepgram", model: "nova-2" },
      // Detect answering machines and leave a concise message instead of
      // waiting for a person who never picks up.
      voicemailDetection: buildVoicemailDetection(),
      voicemailMessage,
      analysisPlan: buildAnalysisPlan(),
    },
  };

  // When a webhook URL is configured, have Vapi deliver server messages
  // (including the end-of-call-report) to it. If a shared secret is set, send
  // it as a custom header so the receiver can verify the request came from us.
  if (process.env.WEBHOOK_URL) {
    payload.assistant.server = { url: process.env.WEBHOOK_URL };
    if (process.env.VAPI_WEBHOOK_SECRET) {
      payload.assistant.server.headers = {
        "x-vapi-secret": process.env.VAPI_WEBHOOK_SECRET,
      };
    }
  }

  const res = await fetch(`${VAPI_BASE}/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.message || JSON.stringify(data) || res.statusText;
    throw new Error(`Vapi create-call failed (${res.status}): ${detail}`);
  }
  return data;
}

/**
 * Fetch a call by id, returning its status, transcript, and summary.
 * @param {string} callId
 */
export async function getCall(callId) {
  const token = requireEnv("VAPI_TOKEN");

  const res = await fetch(`${VAPI_BASE}/call/${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.message || res.statusText;
    throw new Error(`Vapi get-call failed (${res.status}): ${detail}`);
  }

  const structured = data.analysis?.structuredData ?? {};
  return {
    id: data.id,
    status: data.status,
    endedReason: data.endedReason ?? null,
    summary: data.analysis?.summary ?? data.summary ?? null,
    transcript: data.transcript ?? null,
    recordingUrl: data.recordingUrl ?? null,
    outcome: resolveOutcome(structured.outcome, data.endedReason),
    callbackTime: structured.callback_time || null,
    notes: structured.notes || null,
    startedAt: data.startedAt ?? null,
    endedAt: data.endedAt ?? null,
  };
}
