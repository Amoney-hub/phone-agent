import { JSDOM } from "jsdom";
import fs from "node:fs";
const out = [];
const log = (...a) => out.push(a.join(" "));
try {
  const html = fs.readFileSync("src/dashboard.html", "utf8");
  const CLIENT = { id: 2, name: "bb", username: null, has_login: false, outcome_values: {}, api_key: "ck_abc" };
  const fetchLog = [];
  function fakeFetch(url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    fetchLog.push(method + " " + url);
    const json = (o) => Promise.resolve({ ok: true, status: 200, json: async () => o });
    if (url === "/api/me") return json({ role: "admin", username: "admin", clients: [CLIENT], default_client_id: 1 });
    if (url === "/api/status") return json({ vapi: true, twilio: false });
    if (url.startsWith("/api/results")) return json({ estimated_value: 0, jobs_booked: 0, total_calls: 0, currency: "USD", breakdown: [] });
    if (url.startsWith("/api/contacts")) return json([]);
    if (url.startsWith("/api/calls")) return json([]);
    if (url.includes("/login") && method === "PUT") { CLIENT.has_login = true; CLIENT.username = "acme"; return json(CLIENT); }
    return json({});
  }
  const vc = new (await import("jsdom")).VirtualConsole();
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "http://localhost/#clients", virtualConsole: vc,
    beforeParse(window) { window.fetch = (u, o) => fakeFetch(u, o); window.confirm = () => true; },
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(200);

  log("=== BUG 1: refresh while on #clients ===");
  const opts = [...$("#clientSwitcher").options].map((o) => o.textContent);
  log("switcher options:", JSON.stringify(opts));
  const cfg = $("#clientConfig");
  log("clientConfig shows:", cfg.querySelector("#loginForm") ? "client rendered" : (cfg.querySelector("#newClientForm") ? "CREATE empty state (selection lost)" : "EMPTY: '" + cfg.textContent.trim().slice(0,40) + "'"));

  log("\n=== BUG 2: select client, submit login ===");
  const sw = $("#clientSwitcher"); sw.value = "2"; sw.dispatchEvent(new window.Event("change"));
  await wait(120);
  const form = $("#loginForm");
  log("login form present:", !!form, "| onsubmit bound:", !!(form && form.onsubmit));
  if (form) {
    $("#clPass").value = "secretpw";
    const before = fetchLog.length;
    const ev = new window.Event("submit", { cancelable: true, bubbles: true });
    form.dispatchEvent(ev);
    await wait(120);
    log("submit defaultPrevented:", ev.defaultPrevented);
    log("PUT login called:", fetchLog.slice(before).some((x) => /PUT \/api\/clients\/2\/login/.test(x)));
  }
  log("fetch log:", JSON.stringify(fetchLog));
} catch (e) { log("THREW:", e.message, "\n", e.stack); }
fs.writeFileSync("./_reproout.txt", out.join("\n"));
