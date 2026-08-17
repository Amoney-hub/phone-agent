// Pre-call requirement check. Before dialing, an LLM predicts what the person
// being called will ask for (name, callback number, address, dates/times,
// party size, budget, vehicle/part details, …) and whether each is already in
// the objective. If anything is missing we DON'T place the call — the caller
// gets a `needs_info` response with the specific questions to ask the user.
//
// Uses the Anthropic Messages API (Claude Haiku). Without an API key the check
// is skipped (fail-open) so calls still go through — set ANTHROPIC_API_KEY to
// enable it. The assistant can only answer with facts in the objective, so this
// stops calls that would predictably stall on a question it can't answer.

import { classifierConfigured } from "./classify.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL =
  process.env.REQUIREMENTS_MODEL || process.env.CLASSIFY_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = [
  "You help an AI voice assistant that places a phone call on a user's behalf.",
  "The assistant can ONLY answer questions using facts stated in the call",
  "objective — it cannot invent details.",
  "",
  "Given the objective, list the information the person being CALLED will",
  "predictably ask for and that the assistant must be able to provide to finish",
  "the task — for example: the caller's name, a callback phone number, an",
  "address, specific date(s) and time(s), party size, budget/price range, a",
  "vehicle or part detail, an account/reservation/order number, etc. Include",
  "ONLY items that clearly apply to THIS objective; don't invent needs.",
  "",
  "For each requirement, decide whether that information is already present in",
  "the objective.",
  "",
  "Respond with ONLY a JSON object, no prose:",
  '{"requirements": [',
  '  {"field": "<short snake_case id>",',
  '   "question": "<a question the assistant can ask the USER to obtain this>",',
  '   "present": <true if the objective already contains it, else false>}',
  "]}",
  "",
  "Phrase each question so it can be shown directly to the user who asked for",
  "the call (e.g. \"What phone number should they call you back on?\").",
].join("\n");

const cache = new Map();
const CACHE_MAX = 2000;

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}

async function callLLM(objective) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Call objective:\n"""\n${objective}\n"""` }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API ${res.status}`);
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  return extractJson(text);
}

/**
 * @returns {Promise<{complete: boolean, missing: Array<{field:string, question:string}>, checked: boolean}>}
 * `checked` is false when no LLM is configured or the call failed (fail-open).
 */
export async function checkObjectiveRequirements(objective) {
  if (!classifierConfigured()) {
    return { complete: true, missing: [], checked: false };
  }
  const key = String(objective || "").trim();
  if (cache.has(key)) return cache.get(key);

  let out;
  try {
    const parsed = await callLLM(objective);
    const reqs = Array.isArray(parsed.requirements) ? parsed.requirements : [];
    const missing = reqs
      .filter((r) => r && r.present === false && r.question)
      .map((r) => ({ field: String(r.field || "info"), question: String(r.question) }));
    out = { complete: missing.length === 0, missing, checked: true };
  } catch (err) {
    // Fail open — never block a call because the checker is unavailable.
    console.error("[requirements] LLM error, allowing call:", err.message);
    out = { complete: true, missing: [], checked: false };
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, out);
  return out;
}

export function _clearCache() {
  cache.clear();
}
