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
  "An AI voice assistant will place a phone call for a user and can ONLY use facts stated in the objective.",
  "List what the person being CALLED will predictably ask for to complete the task (e.g. caller name, callback number, address, date/time, party size, budget, vehicle/part, account/reservation/order number). Include only items that apply to THIS objective; don't invent needs.",
  "For each, mark whether it's already present in the objective.",
  'Reply with ONLY JSON: {"requirements":[{"field":"<snake_case>","question":"<question to ask the USER to obtain it>","present":<bool>}]}',
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
      max_tokens: 300,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Objective: ${objective}` }],
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
