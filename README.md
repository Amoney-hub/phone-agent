# phone-agent

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant manage
contacts, send text messages, and place autonomous phone calls.

- **Contacts** are stored locally in SQLite (`better-sqlite3`).
- **Texts** are sent through the [Twilio](https://www.twilio.com/) SMS API.
- **Calls** are placed through [Vapi](https://vapi.ai/), using a *transient*
  (inline) assistant whose system prompt is generated from a plain-language
  objective you provide.

## Tools

| Tool | Arguments | Description |
| --- | --- | --- |
| `add_contact` | `name`, `phone`, *(optional)* `client` | Add or update a contact. `phone` should be E.164, e.g. `+15551234567`. |
| `send_text` | `name`, `message`, *(optional)* `client` | Send an SMS to a saved contact via Twilio. |
| `make_call` | `name`, `objective`, *(optional)* `voicemail_message`, `client` | Place a Vapi call to a saved contact. Checks the objective for completeness first (see below). Returns a `call_id`, or a `needs_info` response. |
| `call_list` | `names[]`, `objective`, *(optional)* `voicemail_message`, `client` | Place calls to several contacts with the same objective, staggered a few seconds apart. Returns a `batch_id` and a table of names/`call_id`s. |
| `get_call_result` | `call_id` | Fetch a call's status, structured outcome, transcript, and summary. |
| `get_batch_result` | `batch_id` | Fetch the outcome of every call in a batch placed by `call_list`. |

### Pre-call requirement checking

Before `make_call` dials, the objective is run through an LLM (Anthropic Claude
Haiku) that predicts what the person being called will **predictably ask for** —
the caller's name, a callback number, an address, specific dates/times, party
size, budget, vehicle/part details, an account number, etc. — and checks whether
each is already in the objective. Since the assistant can only answer with facts
in the objective, this stops calls that would stall on a question it can't answer.

If anything is missing, **the call is not placed**. Instead you get a structured
`needs_info` response listing the specific missing fields as questions, so the
calling client can ask the user and retry with a complete objective:

- **MCP `make_call`** returns a `needs_info:` message with numbered questions.
- **`POST /api/calls`** returns `422 { "needs_info": true, "missing": [{ "field", "question" }] }`.

The call only dials once the objective is complete. This requires
`ANTHROPIC_API_KEY`; without it the check is skipped (fail-open) and calls go
through as before.

### Voicemail handling

Every call is placed with Vapi **voicemail detection** enabled. If the call
reaches an answering machine instead of a person, the assistant leaves a short
**voicemail message** (generated from the objective) and hangs up. Pass an
optional `voicemail_message` to `make_call` / `call_list` to override that text
(it applies to every call in a batch). Calls that hit voicemail are reliably
tagged with `outcome: voicemail` — a voicemail ended-reason overrides whatever
the structured-data model guessed.

### Structured call outcomes

Every call is placed with a Vapi **analysis plan** that extracts a structured
summary once the call ends. The end-of-call webhook saves it onto the call's row:

- `outcome` — one of `reached`, `voicemail`, `not_interested`, `interested`,
  `booked`, `callback_requested`.
- `callback_time` — *(optional)* a time/date the person asked to be called back.
- `notes` — *(optional)* a short free-text note worth remembering.

These are returned by `get_call_result` / `get_batch_result` and shown in the
dashboard call list, which has an **Outcome** filter.

## Prerequisites

- **Node.js 18+** (developed and tested on Node 24).
- A **Twilio** account with an SMS-capable phone number.
- A **Vapi** account with a private API token and a phone number ID.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

   > `better-sqlite3` is a native module. On most platforms a prebuilt binary is
   > downloaded automatically. If your platform has no prebuild, you'll need build
   > tools (on Windows: the "Desktop development with C++" workload from Visual
   > Studio Build Tools).

2. **Configure environment variables**

   Copy the example file and fill in your credentials:

   ```bash
   cp .env.example .env
   ```

   | Variable | Where to find it |
   | --- | --- |
   | `TWILIO_SID` | Twilio Console → Account SID |
   | `TWILIO_AUTH` | Twilio Console → Auth Token |
   | `TWILIO_NUMBER` | Your Twilio phone number, E.164 format |
   | `VAPI_TOKEN` | Vapi Dashboard → API Keys (private key) |
   | `VAPI_PHONE_ID` | Vapi Dashboard → Phone Numbers → the number's ID |
   | `PHONE_AGENT_DB` | *(optional)* path to the SQLite file; defaults to `./contacts.db` |
   | `DASHBOARD_USER` | Dashboard login username (see [Dashboard authentication](#dashboard-authentication)) |
   | `DASHBOARD_PASSWORD_HASH` | bcrypt hash of the dashboard password (`npm run hash-password`) |
   | `VAPI_WEBHOOK_SECRET` | *(optional)* shared secret to verify Vapi webhook calls |
   | `TRIGGER_API_KEY` | *(optional)* bearer token for `POST /api/trigger/call` (see [Inbound call triggers](#inbound-call-triggers)) |
   | `CALL_HOURS` | *(optional)* business-hours window for triggers, e.g. `08:00-19:00` |
   | `CALL_TIMEZONE` | *(optional)* zone for `CALL_HOURS` (default `America/Chicago`) |

3. **Run the server**

   ```bash
   npm start
   ```

   The server communicates over **stdio**, so it's normally launched by an MCP
   client rather than run by hand. Log output goes to stderr to keep the stdio
   JSON-RPC stream clean.

## Connecting to an MCP client

Add the server to your client's MCP configuration. For example, in Claude
Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "phone-agent": {
      "command": "node",
      "args": ["C:/Users/Goat/Documents/phone-agent/src/index.js"]
    }
  }
}
```

Environment variables are read from the `.env` file next to the code, so the
client config doesn't need to repeat your secrets. (You can also pass them via
the client's own `env` block if you prefer.)

## Remote mode (shared database)

By default the MCP server keeps its own local SQLite file. If you also run the
webhook/dashboard server elsewhere (e.g. on Railway), that deployment has a
*separate* database — so calls placed locally and the end-of-call reports
received by the hosted webhook would land in two different places.

Set **`REMOTE_API_URL`** to the hosted server's base URL to fix this: all four
call tools (`make_call`, `call_list`, `get_call_result`, `get_batch_result`)
plus `add_contact`/`send_text` then call the hosted HTTP API instead of touching
local SQLite, so everything shares one database.

```
REMOTE_API_URL=https://your-app.up.railway.app
TRIGGER_API_KEY=<same value as on the server>
```

- Requests authenticate with `TRIGGER_API_KEY` as a bearer token; the hosted
  `/api` routes accept **either** that token **or** a dashboard session.
- SMS (`send_text`) is always sent from the local process (there is no hosted
  SMS route); it just resolves the contact through the API first.
- When `REMOTE_API_URL` is unset, everything works exactly as before against
  local SQLite — the local database is not even opened in remote mode.

The hosted API routes used by remote mode: contacts CRUD (`/api/contacts`),
`POST /api/calls`, `POST /api/calls/batch`, `GET /api/calls/:id`, and
`GET /api/calls/batch/:batchId`.

## Typical flow

1. `add_contact` — `{ "name": "Mom", "phone": "+15551234567" }`
2. `send_text` — `{ "name": "Mom", "message": "Running 10 min late!" }`
3. `make_call` — `{ "name": "Mom", "objective": "Ask if she needs anything from the store." }`
   → returns a `call_id`.
4. `get_call_result` — `{ "call_id": "..." }` once the call has ended, to read
   the outcome, transcript, and summary. (Calls take time; if you query too early
   you'll get a "still in progress" note — just retry.)

To call several people at once, use `call_list` instead of `make_call`:

1. `call_list` — `{ "names": ["Mom", "Dad", "Sam"], "objective": "Confirm you can make dinner Saturday at 7." }`
   → returns a `batch_id` and a table of `call_id`s.
2. `get_batch_result` — `{ "batch_id": "..." }` to see each call's outcome
   (`reached`, `booked`, `voicemail`, …), callback time, and notes.

## End-of-call webhook (optional but recommended)

Vapi calls finish asynchronously. Instead of polling the Vapi API, you can run a
small webhook that receives Vapi's **end-of-call-report** and caches the result
(status, summary, transcript, recording URL) into a `calls` table in the same
SQLite database. `get_call_result` then reads from that table first (instant),
falling back to the Vapi API only when a report hasn't arrived yet.

1. **Run the webhook server** (listens on port `3117`):

   ```bash
   npm run webhook
   ```

   Endpoints: `POST /vapi/webhook` (Vapi server messages), `GET /health`, the
   web dashboard at `GET /`, and the dashboard's JSON API under `/api/`.

2. **Expose it publicly** so Vapi can reach it. In development, use a tunnel:

   ```bash
   ngrok http 3117
   ```

3. **Set `WEBHOOK_URL`** in `.env` to the public URL of the endpoint, e.g.:

   ```
   WEBHOOK_URL=https://<subdomain>.ngrok.io/vapi/webhook
   ```

   When `WEBHOOK_URL` is set, `make_call` attaches it as the assistant's
   `server.url`, so Vapi posts the end-of-call report there automatically. When
   it's unset, everything still works — `get_call_result` just uses the Vapi API.

4. **Verify the webhook (recommended).** Set `VAPI_WEBHOOK_SECRET` in `.env` to a
   long random string. When set, `make_call` sends it to Vapi as a custom
   `x-vapi-secret` header on the assistant's `server` config, and `/vapi/webhook`
   **rejects any request that doesn't carry a matching header** (401). The webhook
   itself stays outside the dashboard's cookie session (Vapi can't log in), so
   this shared secret is what authenticates it. If the var is unset, the webhook
   accepts unauthenticated requests (with a startup warning).

## Dashboard authentication

The dashboard page (`/`) and every `/api/` route are protected by a simple
session login: a single admin user whose username and **bcrypt** password hash
come from `DASHBOARD_USER` and `DASHBOARD_PASSWORD_HASH`. Only `/health`,
`/login`, `/logout`, and `/vapi/webhook` are open.

1. **Generate a password hash:**

   ```bash
   npm run hash-password -- 'your-password'
   # or, to keep it out of shell history, run with no argument and type it in:
   npm run hash-password
   ```

2. **Set the credentials** in `.env` (quote the hash — it contains `$`):

   ```
   DASHBOARD_USER=admin
   DASHBOARD_PASSWORD_HASH='$2b$12$...'
   ```

3. Restart the webhook server and visit the dashboard. You'll be redirected to
   **`/login`**; after signing in, an `HttpOnly` session cookie (12 h) keeps you
   authenticated. Use the **Log out** button in the header (or `GET /logout`) to
   end the session.

Notes:

- Sessions are stateless HMAC-signed cookies — no session store needed. The
  signing key defaults to a value derived from the password hash, so **changing
  the password invalidates all existing sessions**. Set `SESSION_SECRET` to pin
  it explicitly.
- Behind HTTPS, set `DASHBOARD_SECURE_COOKIE=true` (or terminate TLS with an
  `x-forwarded-proto: https` header) to add the `Secure` flag to the cookie.
- If auth is **not** configured, the dashboard and API fail closed (redirect /
  `503`) rather than exposing your data.

## Multi-tenancy & client access

Contacts, calls, appointments, and batches each belong to a **client** (tenant).
There are two roles:

- **admin** (the `DASHBOARD_USER` above): full access across all clients. Sees
  the whole dashboard plus a **client switcher** (top-right) to view "All
  clients" or scope everything to one, and a **Client settings** panel to create
  clients, set each client's **per-outcome dollar values**, and set a client
  login.
- **client**: signs in to a **read-only** workspace showing only their own data —
  a results header (**jobs booked / shifts filled** + **estimated value** from
  the admin-set per-outcome values), an outcome breakdown, and their call log
  with transcripts and recording playback. Clients never see other tenants'
  data, prompts/objectives, per-minute costs, or admin controls (enforced
  server-side, not just hidden in the UI).

Existing data is migrated to a **Default** client on first launch, so a
single-tenant setup keeps working unchanged (the MCP tools and inbound triggers
operate on the Default client).

Create a client and give them a login, either from **Client settings** in the
dashboard, or on the CLI:

```bash
npm run add-client -- "Acme Plumbing" acme s3cret '{"booked":200,"interested":40}'
```

The estimated value is `Σ (calls with outcome × that outcome's dollar value)`,
priced per client. Admins can optionally set `COST_PER_MINUTE` for an
admin-only cost estimate that is never exposed to clients.

### Per-client attribution

Every client gets its own **trigger API key** (`ck_…`), shown in **Client
settings** (with a Copy/Regenerate control) and mapped to that client's id.
Calls are attributed to whichever key or parameter was used, falling back to the
Default client only when neither is given:

- **Inbound triggers**: calling `POST /api/trigger/call` with a **client's key**
  attributes the call to that client; the **global `TRIGGER_API_KEY`** attributes
  to Default. A client key also grants read-only, tenant-scoped access to the
  rest of `/api` (same as that client's login).
- **MCP tools**: `add_contact`, `send_text`, `make_call`, and `call_list` take an
  optional **`client`** parameter (name or id) to act on behalf of a specific
  client. Omit it for the Default client. (In remote mode this is forwarded to
  the hosted API; the admin `TRIGGER_API_KEY` bearer authorizes it.)
- **Dashboard**: admins can also place under the currently selected client via
  the client switcher, or pass `"client"` in the `POST /api/calls` body.

## Inbound call triggers

External systems (CRMs, form handlers, Zapier, etc.) can start calls by posting
to **`POST /api/trigger/call`**. Unlike the rest of `/api`, this route uses a
**bearer token** instead of the dashboard session, so it's callable from
machines that can't log in.

1. **Enable it** by setting `TRIGGER_API_KEY` in `.env` to a long random string.
   Until it's set, the endpoint returns `503` (disabled). Use the **global**
   `TRIGGER_API_KEY` for calls that should attribute to the Default client, or a
   **client's own key** (from Client settings) to attribute to that client — see
   [Per-client attribution](#per-client-attribution).

2. **Call it** with the token and a JSON body:

   ```bash
   curl -X POST http://localhost:3117/api/trigger/call \
     -H "Authorization: Bearer $TRIGGER_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"name":"Mom","phone":"+15551234567","objective":"Confirm dinner Saturday","tag":"crm"}'
   ```

   | Field | Required | Meaning |
   | --- | --- | --- |
   | `name` | yes | Contact name (the contact is **upserted** by name). |
   | `phone` | yes | E.164 number; updates the contact's number. |
   | `objective` | yes | Plain-language goal for the call. |
   | `tag` | no | Source tag, stored on the call and shown in the dashboard (defaults to `trigger`). |
   | `outside_hours` | no | `"queue"` (default) or `"reject"` — behavior when outside call hours. |

   On success it upserts the contact, places the call, and returns
   `201 { "status": "placed", "call_id": "...", "tag": "...", "contact": {...} }`.

**Rate limiting.** At most **30 accepted triggers per rolling hour** (override
with `TRIGGER_RATE_MAX`). Over the limit returns `429` with a `Retry-After`
header.

**Business-hours guard.** Set `CALL_HOURS` (e.g. `08:00-19:00`), evaluated in
`CALL_TIMEZONE` (default `America/Chicago`). A trigger received **outside** the
window is, by default, **queued** and placed automatically when the window
reopens (`202 { "status": "queued", "scheduled_for": ... }`); a background worker
drains the queue every minute, and the queue survives restarts. Send
`{"outside_hours":"reject"}` to get a `409` instead. When `CALL_HOURS` is unset,
calls go out at any hour. Every triggered call is logged with its source tag.

## Abuse prevention (account tiers)

Each account (client/tenant) has a **tier** that gates what it can do. The
platform owner's **Default** tenant is `unlimited` (never restricted); new
self-serve accounts default to `free`.

| Tier | Calls/day | Distinct #s/week | Batch calling | Bulk import | First calls reviewed |
| --- | --- | --- | --- | --- | --- |
| `free` | 20 | 15 | ✗ | ✗ | first 10 |
| `pro` | 500 | 1000 | ✓ | ✓ | — |
| `unlimited` | ∞ | ∞ | ✓ | ✓ | — |

Limits are configurable via env (see `.env.example`). Admins set a tier from
**Client settings** or `PUT /api/clients/:id/tier`.

Enforced on every call placement (single, batch, and inbound trigger):

1. **Objective screening** — the plain-language objective is classified by an
   LLM (Anthropic Claude Haiku when `ANTHROPIC_API_KEY` is set; a keyword
   heuristic otherwise) and **sales / marketing / promotional** intent is
   rejected with a clear error (`422`). Skipped for the `unlimited` tier.
2. **Rate limits** — calls/day and distinct-numbers/week per tier (`429` when
   hit; re-calling a number you already reached this week doesn't count again).
3. **Capabilities** — batch calling and bulk contact import are blocked on the
   `free` tier (`403`).

**Abuse flagging.** When one objective (normalized) is sent to many distinct
numbers within a week, the account is flagged (`ABUSE_OBJECTIVE_THRESHOLD`,
default 5). Flags appear in the dashboard's **Review** tab.

**Review queue.** A new account's first calls are marked for review; the
**Review** tab shows them with objective + transcript + recording so an admin
can **Approve** or **Flag** the account. A badge on the nav shows the pending
count. Routes: `GET /api/review`, `POST /api/review/:callId {status}`,
`GET /api/flags`, `POST /api/flags/:id/resolve`.

## Developer API (`/v1`)

The webhook server also exposes a versioned REST API for developers under
**`/v1`**, authenticated with per-client API keys. Responses are consistent
JSON: resources are flat objects with an `object` field, lists are
`{ object: "list", data: [...] }`, and errors always use the shape
`{ error: { type, code, message, param? } }` with a matching HTTP status.

**Authentication.** Send `Authorization: Bearer <api_key>`. Keys are created and
managed in the dashboard's **Developer** tab (admin only). The legacy per-client
key and the global `TRIGGER_API_KEY` (→ Default client) are also accepted.

**Endpoints**

| Method & path | Description |
| --- | --- |
| `POST /v1/calls` | Place a call (`contact` name or `phone` + `objective`) |
| `GET /v1/calls` | List calls (`limit`, `offset`) |
| `GET /v1/calls/:id` | Retrieve a call |
| `POST /v1/messages` | Send an SMS (`to`, `body`) |
| `GET /v1/messages/:id` | Retrieve a message |
| `GET /v1/contacts` · `POST /v1/contacts` | List / create contacts |
| `GET·PUT·DELETE /v1/contacts/:id` | Retrieve / update / delete a contact |
| `POST /v1/batches` | Place a batch (`names[]`, `objective`) |
| `GET /v1/batches/:id` | Retrieve a batch and its calls |
| `GET /v1/usage` | Usage totals (`period` = day\|week\|month\|all) |
| `GET·PUT /v1/webhooks` | Get / set the outbound webhook config |
| `GET /v1/openapi.json` | Machine-readable OpenAPI 3.1 spec (public) |

**Rate limiting & usage.** Each key gets a sliding-window rate limit
(`V1_RATE_PER_MIN`, default 120/min) with `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers, returning `429` with
`Retry-After` when exceeded. Every request is logged (status + latency) and
call/message actions are tracked for `GET /v1/usage`.

**Outbound webhooks.** Configure a webhook URL per client (Developer tab or
`PUT /v1/webhooks`). When a call ends we `POST` a signed `call.completed` event:

```
X-PhoneAgent-Event:     call.completed
X-PhoneAgent-Timestamp: 1718900000
X-PhoneAgent-Signature: sha256=<hmac>
```

Verify with `hmac = HMAC_SHA256(secret, "<timestamp>.<raw_body>")`. Delivery
retries a few times (`WEBHOOK_MAX_ATTEMPTS`) and every attempt is logged.

### Developer console & public page

- **Developer tab** (admin dashboard only): create / rotate / revoke multiple
  API keys, view usage charts, a request log with status codes + latency, and
  API docs generated from the OpenAPI spec. Backed by `requireAdmin` routes
  under `/api/developer/*` — no client or role can reach it, by UI or direct URL.
- **Public `/developers` page**: an open "coming soon" landing page with email
  capture (`POST /developers/signup`). It exposes no keys, docs, or console.

## Web dashboard

Running `npm run webhook` also serves a dark-theme web dashboard at
**http://localhost:3117/** (vanilla HTML/CSS/JS, no build step). It reads the
same SQLite database and provides:

- **Contacts** — table of name/phone with inline add, edit, and delete.
- **Call history** — calls newest first with contact name, status, structured
  **outcome** badge, **source tag** (for triggered calls), duration, and summary;
  filter by outcome, and click a call to expand its callback time, notes, full
  transcript, and recording (when present).
- **Status strip** — shows whether Vapi and Twilio are configured.

It's backed by these JSON endpoints on the same server. All `/api/` routes
require a valid session (see [Dashboard authentication](#dashboard-authentication)):

| Method & path | Purpose |
| --- | --- |
| `POST /login` | Sign in (`{ username, password }`), sets the session cookie |
| `GET` / `POST /logout` | Clear the session cookie |
| `POST /api/trigger/call` | Start a call (bearer-token auth — see [Inbound call triggers](#inbound-call-triggers)) |
| `GET /api/status` | Whether Vapi / Twilio are configured |
| `GET /api/contacts` | List contacts |
| `POST /api/contacts` | Add a contact (`{ name, phone }`) |
| `PUT /api/contacts/:id` | Update a contact |
| `DELETE /api/contacts/:id` | Delete a contact |
| `GET /api/calls` | Call history, newest first |

## Notes & customization

- The transient assistant's voice, model, and transcriber are set in
  `src/vapi.js` (`createCall`). Adjust the `voice`, `model`, and `transcriber`
  blocks there to change providers or personas.
- The call system prompt is built by `buildSystemPrompt(objective)` in the same
  file. The objective is treated as a **private instruction** to the assistant —
  delimited and never read aloud or quoted (it may itself contain directions like
  "identify yourself as..."). Tweak this to change tone or guardrails.
- **AI disclosure** is controlled by `DISCLOSE_AI` (default `true`). When `true`,
  the assistant opens by stating it's an AI calling on the user's behalf. When
  `false`, it doesn't volunteer that it's an AI — but it **always answers honestly
  if directly asked** whether it's a bot/AI/real person. (Bot-disclosure laws vary
  by jurisdiction; compliance is your responsibility.)
- Voicemail: by default the assistant **composes its own** short, natural
  voicemail (paraphrasing the objective's intent — never speaking it verbatim).
  Detection is configured by `buildVoicemailDetection`. To pin exact words for a
  specific call, pass the `voicemail_message` tool argument; `buildVoicemailMessage`
  is a generic, objective-free fallback.
- Contacts are keyed by name (case-insensitive, unique). Adding a contact with an
  existing name updates that contact's number.

## Project layout

```
src/
  index.js    MCP server: registers the contact/call tools, picks local/remote backend
  remote.js   HTTP client + backend used when REMOTE_API_URL is set (bearer auth)
  calls.js    Shared call ops (place/batch/fetch) used by the server and local MCP mode
  db.js       SQLite storage (better-sqlite3): tenants, contacts, calls, batches, appointments
  metrics.js  Client results: jobs booked / estimated value / outcome breakdown
  twilio.js   Twilio SMS client
  vapi.js     Vapi call client + system-prompt builder
  auth.js     Session auth (admin + client roles, bcrypt), scoping + bearer guard
  tiers.js    Account tiers + per-tier limits/capabilities
  classify.js LLM objective classifier (Claude Haiku) + heuristic fallback
  requirements.js Pre-call requirement check (needs_info) for make_call
  guard.js    Abuse guard: classification, rate limits, review flagging, detection
  trigger.js  Inbound trigger endpoint: bearer auth, rate limit, out-of-hours queue
  callhours.js   Business-hours window parsing + timezone evaluation
  webhook.js  Express server (port 3117): Vapi webhook + dashboard + /api + /v1 + /developers
  apiv1.js    Versioned developer REST API (/v1): key auth, rate limit, usage, request log
  openapi.js  OpenAPI 3.1 spec builder (served at /v1/openapi.json; drives the docs)
  outboundwebhooks.js  Signed call.completed webhook delivery (HMAC) + retries
  dashboard.js   Loads and serves the admin dashboard, client, login, and developers HTML
  dashboard.html Admin dashboard (client switcher, results, config, Developer tab) — HTML/CSS/JS
  client.html    Read-only client results workspace — HTML/CSS/JS
  developers.html Public "coming soon" developers landing page (email capture)
  login.html     Self-contained login page
scripts/
  hash-password.js  Generate a bcrypt hash for DASHBOARD_PASSWORD_HASH
  add-client.js     Create a client tenant with an optional login + values
.env.example  Template for required credentials
```

## Security

Your `.env` file and `*.db` files contain credentials and personal contact data.
They are excluded via `.gitignore` — keep them out of version control.

The dashboard stores only a **bcrypt hash** of the admin password, never the
password itself. Still, the dashboard exposes contact data and call transcripts,
so run the webhook server behind HTTPS in production (set
`DASHBOARD_SECURE_COOKIE=true`) and always configure `DASHBOARD_PASSWORD_HASH`
and `VAPI_WEBHOOK_SECRET`.
