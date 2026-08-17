// Client-facing results: the "jobs booked / shifts filled" headline, estimated
// dollar value (from the admin-configured per-outcome values), and the outcome
// breakdown. Scoped to one tenant, or aggregated across all (admin).

import { outcomeCounts, countCalls, getClientOutcomeValues } from "./db.js";
import { CALL_OUTCOMES } from "./vapi.js";

/**
 * @param {number|null} clientId  A tenant id, or null for all clients (admin).
 * @returns {{jobs_booked:number, estimated_value:number, total_calls:number,
 *   currency:string, breakdown:Array<{outcome:string,count:number,value:number}>}}
 */
export function computeResults(clientId = null) {
  const rows = outcomeCounts(clientId); // [{ client_id, outcome, n }]

  // Each call's dollar value uses ITS OWN client's configured values, so the
  // aggregate ("all clients") view stays correct across differently-priced
  // tenants.
  const valuesByClient = new Map();
  const valuesFor = (cid) => {
    if (!valuesByClient.has(cid)) valuesByClient.set(cid, getClientOutcomeValues(cid));
    return valuesByClient.get(cid);
  };

  const byOutcome = new Map(); // outcome -> { count, value }
  let estimatedValue = 0;
  for (const r of rows) {
    const perUnit = Number(valuesFor(r.client_id)[r.outcome] || 0);
    const value = perUnit * r.n;
    const acc = byOutcome.get(r.outcome) || { count: 0, value: 0 };
    acc.count += r.n;
    acc.value += value;
    byOutcome.set(r.outcome, acc);
    estimatedValue += value;
  }

  const breakdown = CALL_OUTCOMES.map((o) => {
    const acc = byOutcome.get(o) || { count: 0, value: 0 };
    return { outcome: o, count: acc.count, value: round2(acc.value) };
  });

  return {
    jobs_booked: byOutcome.get("booked")?.count || 0,
    estimated_value: round2(estimatedValue),
    total_calls: countCalls(clientId),
    currency: process.env.RESULTS_CURRENCY || "USD",
    breakdown,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
