// Abuse-prevention guard applied around every call placement. Enforces:
//  - per-tier capabilities (batch calling, bulk import)
//  - LLM objective classification (reject sales/marketing/promotional)
//  - per-tier rate limits (calls/day, distinct numbers/week)
//  - review flagging of new accounts' first calls
//  - abuse detection (same objective sprayed to many numbers)
//
// Every check is a no-op for the Default/unlimited tenant, so the platform
// owner's own usage (MCP, global trigger key) is never blocked.

import {
  getClientTier,
  countCalls,
  callsPlacedSince,
  distinctNumbersSince,
  numberCalledSince,
  repeatObjectiveGroups,
  addAbuseFlag,
} from "./db.js";
import { tierFor } from "./tiers.js";
import { classifyObjective, normalizeObjective } from "./classify.js";

const DAY = "-1 day";
const WEEK = "-7 days";

function abuseThreshold() {
  const v = Number(process.env.ABUSE_OBJECTIVE_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

/** Error carrying a `code` so HTTP routes can map it to a status. */
export class GuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GuardError";
    this.code = code; // "classification" | "capability" | "rate"
  }
}

/**
 * Capability + objective classification. Run ONCE per placement (or per batch,
 * since a batch shares one objective). Throws GuardError on rejection.
 * @returns {Promise<{ objectiveNorm: string }>}
 */
export async function guardObjectiveAndCapability({ clientId, objective, kind = "single" }) {
  const tier = tierFor(getClientTier(clientId));

  if (kind === "batch" && !tier.allowBatch) {
    throw new GuardError(
      `Batch calling isn't available on the ${tier.label} tier. Upgrade to place calls to multiple contacts at once.`,
      "capability"
    );
  }

  if (tier.classify) {
    const c = await classifyObjective(objective);
    if (!c.allowed) {
      throw new GuardError(
        `This objective looks like ${c.category} outreach, which isn't allowed on this service. ` +
          `phone-agent is for personal and service calls (bookings, reminders, questions), not sales, ` +
          `marketing, or promotional calls.${c.reason ? " (" + c.reason + ")" : ""}`,
        "classification"
      );
    }
  }

  return { objectiveNorm: normalizeObjective(objective) };
}

/**
 * Per-call rate limits for the client's tier. Run for EACH call (so a batch
 * stops once the day/week caps are hit). Throws GuardError on rejection.
 */
export function guardRate({ clientId, phone }) {
  const tier = tierFor(getClientTier(clientId));

  if (tier.callsPerDay !== Infinity) {
    const used = callsPlacedSince(clientId, DAY);
    if (used >= tier.callsPerDay) {
      throw new GuardError(
        `Daily call limit reached (${tier.callsPerDay} calls/day on the ${tier.label} tier). Try again tomorrow or upgrade.`,
        "rate"
      );
    }
  }

  if (tier.distinctNumbersPerWeek !== Infinity && phone) {
    // Only counts against the weekly distinct-number cap if this number is new
    // for the client this week (re-calling the same number is fine).
    if (!numberCalledSince(clientId, phone, WEEK)) {
      const distinct = distinctNumbersSince(clientId, WEEK);
      if (distinct >= tier.distinctNumbersPerWeek) {
        throw new GuardError(
          `Weekly limit reached: ${tier.distinctNumbersPerWeek} different numbers per week on the ${tier.label} tier. Upgrade to reach more numbers.`,
          "rate"
        );
      }
    }
  }
}

/** Capability gate for bulk contact import. Throws GuardError if not allowed. */
export function guardBulkImport({ clientId }) {
  const tier = tierFor(getClientTier(clientId));
  if (!tier.allowBulkImport) {
    throw new GuardError(
      `Bulk contact import isn't available on the ${tier.label} tier. Add contacts individually or upgrade.`,
      "capability"
    );
  }
}

/**
 * Whether this call (about to be placed) should go into the admin review queue.
 * New accounts on a tier with `reviewFirstCalls` get their first N calls flagged.
 * Call BEFORE recording the placement (uses the pre-placement count).
 */
export function reviewStatusFor(clientId) {
  const tier = tierFor(getClientTier(clientId));
  if (tier.reviewFirstCalls > 0 && countCalls(clientId) < tier.reviewFirstCalls) {
    return "pending";
  }
  return null;
}

/**
 * After a placement, detect the "same objective to many numbers" pattern and
 * raise/refresh an abuse flag for the account. Cheap; runs post-placement.
 */
export function runAbuseDetection(clientId) {
  const groups = repeatObjectiveGroups(clientId, WEEK, abuseThreshold());
  for (const g of groups) {
    addAbuseFlag({
      clientId,
      kind: "repeat_objective",
      detail: (g.objective_norm || "").slice(0, 120),
      count: g.numbers,
    });
  }
  return groups;
}
