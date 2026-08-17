// Account tiers and their limits. "Accounts" are clients (tenants). The cheap
// self-serve tier ("free") is constrained; the platform owner's Default tenant
// runs on "unlimited" so the owner's own usage (MCP, global trigger key) is
// never blocked.

function num(envName, fallback) {
  const v = Number(process.env[envName]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export const TIERS = {
  free: {
    name: "free",
    label: "Free",
    callsPerDay: num("FREE_CALLS_PER_DAY", 20),
    distinctNumbersPerWeek: num("FREE_NUMBERS_PER_WEEK", 15),
    allowBatch: false,
    allowBulkImport: false,
    reviewFirstCalls: num("REVIEW_FIRST_CALLS", 10),
    classify: true,
  },
  pro: {
    name: "pro",
    label: "Pro",
    callsPerDay: num("PRO_CALLS_PER_DAY", 500),
    distinctNumbersPerWeek: num("PRO_NUMBERS_PER_WEEK", 1000),
    allowBatch: true,
    allowBulkImport: true,
    reviewFirstCalls: 0,
    classify: true,
  },
  unlimited: {
    name: "unlimited",
    label: "Unlimited",
    callsPerDay: Infinity,
    distinctNumbersPerWeek: Infinity,
    allowBatch: true,
    allowBulkImport: true,
    reviewFirstCalls: 0,
    classify: false,
  },
};

export const TIER_NAMES = Object.keys(TIERS);

// Tier assigned to newly self-serve created clients.
export const SELF_SERVE_DEFAULT_TIER = "free";

export function tierFor(name) {
  return TIERS[name] || TIERS[SELF_SERVE_DEFAULT_TIER];
}

/** A JSON-serializable view of the tier table for the admin UI. */
export function tiersView() {
  return Object.fromEntries(
    Object.entries(TIERS).map(([k, t]) => [
      k,
      {
        label: t.label,
        calls_per_day: t.callsPerDay === Infinity ? null : t.callsPerDay,
        distinct_numbers_per_week:
          t.distinctNumbersPerWeek === Infinity ? null : t.distinctNumbersPerWeek,
        allow_batch: t.allowBatch,
        allow_bulk_import: t.allowBulkImport,
        review_first_calls: t.reviewFirstCalls,
        classify_objectives: t.classify,
      },
    ])
  );
}
