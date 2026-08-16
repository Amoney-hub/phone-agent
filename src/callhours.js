// Business-hours guard for inbound trigger calls. The window is configured via
// CALL_HOURS ("HH:MM-HH:MM") and evaluated in CALL_TIMEZONE (default
// America/Chicago). When CALL_HOURS is unset, calls are always allowed.

export const CALL_TIMEZONE = process.env.CALL_TIMEZONE || "America/Chicago";

/**
 * Parse a "HH:MM-HH:MM" window into start/end minutes-since-midnight.
 * Returns null when the spec is missing or malformed.
 */
export function parseCallHours(spec = process.env.CALL_HOURS) {
  if (!spec || typeof spec !== "string") return null;
  const m = spec.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [sh, sm, eh, em] = [m[1], m[2], m[3], m[4]].map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return null; // empty/degenerate window
  return { startMin, endMin, spec: spec.trim() };
}

/** Break a Date into wall-clock parts for a given IANA time zone. */
export function zonedParts(date, tz = CALL_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // Intl can emit "24" for midnight in some engines; normalize to 0.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

/**
 * True when `minutes` falls inside [startMin, endMin). Supports windows that
 * wrap past midnight (e.g. 22:00-06:00).
 */
function inWindow(minutes, startMin, endMin) {
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin; // wraps midnight
}

/**
 * Evaluate the business-hours guard for `date` (default now).
 * Returns { enabled, within, spec, timezone }. When the guard is not
 * configured, `enabled` is false and `within` is true (always allowed).
 */
export function evaluateCallHours(date = new Date()) {
  const parsed = parseCallHours();
  if (!parsed) {
    return { enabled: false, within: true, spec: null, timezone: CALL_TIMEZONE };
  }
  const { hour, minute } = zonedParts(date);
  const within = inWindow(hour * 60 + minute, parsed.startMin, parsed.endMin);
  return {
    enabled: true,
    within,
    spec: parsed.spec,
    timezone: CALL_TIMEZONE,
  };
}

/** Convenience boolean: is `date` inside the call window (or guard disabled)? */
export function isWithinCallHours(date = new Date()) {
  return evaluateCallHours(date).within;
}

/**
 * Convert a wall-clock time in `tz` to the corresponding UTC instant. Uses the
 * standard offset-inversion trick so it stays correct across DST changes.
 */
function wallClockToInstant(year, month, day, hour, minute, tz = CALL_TIMEZONE) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const p = zonedParts(new Date(guess), tz);
  const asWall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = asWall - guess; // how far tz leads UTC at that instant
  return new Date(guess - offset);
}

/**
 * Best-effort estimate of the next instant the call window opens, as an ISO
 * string. Informational only (used in the "queued" response); the queue worker
 * itself just re-checks `isWithinCallHours` each tick. Returns null when the
 * guard is disabled.
 */
export function nextWindowOpen(date = new Date()) {
  const parsed = parseCallHours();
  if (!parsed) return null;
  const now = zonedParts(date);
  const nowMin = now.hour * 60 + now.minute;
  const startH = Math.floor(parsed.startMin / 60);
  const startM = parsed.startMin % 60;

  // Opens later today, or first thing tomorrow.
  let { year, month, day } = now;
  if (nowMin >= parsed.startMin) {
    const t = new Date(Date.UTC(year, month - 1, day) + 86400000);
    year = t.getUTCFullYear();
    month = t.getUTCMonth() + 1;
    day = t.getUTCDate();
  }
  return wallClockToInstant(year, month, day, startH, startM).toISOString();
}
