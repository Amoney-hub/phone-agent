// Objective classifier. Before placing a call we classify the plain-language
// objective and refuse sales / marketing / promotional intent. Uses the
// Anthropic Messages API (Claude Haiku — fast + cheap) when ANTHROPIC_API_KEY
// is set, and falls back to a keyword heuristic otherwise so the guardrail
// still functions (and tests run) without an API key.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CLASSIFY_MODEL || "claude-haiku-4-5-20251001";

// Categories that are never allowed on the service.
const DISALLOWED = new Set(["sales", "marketing", "promotional", "advertising", "spam"]);

const SYSTEM_PROMPT = [
  "You are a content-policy classifier for an AI phone-calling assistant.",
  "The assistant places calls for PERSONAL and legitimate one-to-one tasks:",
  "booking or confirming appointments, reminders, asking a question, customer",
  "service, following up on an order, scheduling, etc.",
  "",
  "It must NOT be used for outbound SALES, MARKETING, PROMOTIONAL, or ADVERTISING",
  "outreach, cold-calling to sell, lead-gen, fundraising solicitation, or",
  "spam/robocall campaigns.",
  "",
  "Classify the user's call objective. Respond with ONLY a JSON object, no prose:",
  '{"category": <one of: personal, appointment, reminder, customer_service, informational, survey, sales, marketing, promotional, advertising, spam, other>,',
  ' "disallowed": <true if the objective is sales/marketing/promotional/advertising/spam outreach, else false>,',
  ' "reason": <one short sentence>}',
].join("\n");

// Small bounded cache keyed by the normalized objective.
const cache = new Map();
const CACHE_MAX = 2000;
function cacheGet(k) { return cache.get(k); }
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(k, v);
  return v;
}

/** Normalize an objective for grouping/caching (lowercase, strip digits/punct). */
export function normalizeObjective(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}

async function classifyWithLLM(objective) {
  const key = process.env.ANTHROPIC_API_KEY;
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Call objective:\n"""\n${objective}\n"""` }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API ${res.status}`);
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  const parsed = extractJson(text);
  return {
    category: String(parsed.category || "other").toLowerCase(),
    disallowed: Boolean(parsed.disallowed),
    reason: String(parsed.reason || ""),
  };
}

// Keyword heuristic fallback — deliberately conservative about what it BLOCKS
// (only fairly clear promotional signals) so it doesn't over-reject.
const SALES_PATTERNS = [
  /\bspecial offer\b/, /\blimited[- ]time\b/, /\bdiscount\b/, /\bpromo(tion|tional)?\b/,
  /\bsale\b/, /\bdeal\b/, /\bsign up (for|to)\b/, /\bsubscribe\b/, /\bupgrade to\b/,
  /\bbuy now\b/, /\border now\b/, /\bfree trial\b/, /\bexclusive offer\b/,
  /\bour (product|service|solution)s?\b/, /\binterested in (our|buying)\b/,
  /\bsell(ing)?\b/, /\bmarketing\b/, /\badvertis(e|ing)\b/, /\bcold call\b/,
  /\blead gen(eration)?\b/, /\bnew customers?\b/, /\bgrow your\b/, /\bboost your\b/,
];

function classifyHeuristic(objective) {
  const s = String(objective || "").toLowerCase();
  const hit = SALES_PATTERNS.find((re) => re.test(s));
  if (hit) {
    return { category: "promotional", disallowed: true, reason: "Matches a promotional/sales pattern." };
  }
  return { category: "other", disallowed: false, reason: "No promotional signals detected." };
}

/**
 * Classify a call objective.
 * @returns {Promise<{allowed:boolean, category:string, reason:string, source:string}>}
 */
export async function classifyObjective(objective) {
  const norm = normalizeObjective(objective);
  const cached = cacheGet(norm);
  if (cached) return cached;

  let raw;
  let source;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      raw = await classifyWithLLM(objective);
      source = "llm";
    } catch (err) {
      console.error("[classify] LLM error, using heuristic fallback:", err.message);
      raw = classifyHeuristic(objective);
      source = "heuristic-fallback";
    }
  } else {
    raw = classifyHeuristic(objective);
    source = "heuristic";
  }

  const allowed = !raw.disallowed && !DISALLOWED.has(raw.category);
  return cacheSet(norm, { allowed, category: raw.category, reason: raw.reason, source });
}

/** Whether an LLM classifier is configured (vs. the heuristic fallback). */
export function classifierConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function _clearCache() {
  cache.clear();
}
