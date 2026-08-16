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
| `add_contact` | `name`, `phone` | Add or update a contact. `phone` should be E.164, e.g. `+15551234567`. |
| `send_text` | `name`, `message` | Send an SMS to a saved contact via Twilio. |
| `make_call` | `name`, `objective`, *(optional)* `voicemail_message` | Place a Vapi call to a saved contact. Returns a `call_id`. |
| `call_list` | `names[]`, `objective`, *(optional)* `voicemail_message` | Place calls to several contacts with the same objective, staggered a few seconds apart. Returns a `batch_id` and a table of names/`call_id`s. |
| `get_call_result` | `call_id` | Fetch a call's status, structured outcome, transcript, and summary. |
| `get_batch_result` | `batch_id` | Fetch the outcome of every call in a batch placed by `call_list`. |

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

## Inbound call triggers

External systems (CRMs, form handlers, Zapier, etc.) can start calls by posting
to **`POST /api/trigger/call`**. Unlike the rest of `/api`, this route uses a
**bearer token** instead of the dashboard session, so it's callable from
machines that can't log in.

1. **Enable it** by setting `TRIGGER_API_KEY` in `.env` to a long random string.
   Until it's set, the endpoint returns `503` (disabled).

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
  file — tweak it to change tone, guardrails, or voicemail behavior.
- Voicemail detection and the default voicemail message live in `src/vapi.js`
  (`buildVoicemailDetection` and `buildVoicemailMessage`). The message can also be
  overridden per call via the `voicemail_message` tool argument.
- Contacts are keyed by name (case-insensitive, unique). Adding a contact with an
  existing name updates that contact's number.

## Project layout

```
src/
  index.js    MCP server: registers the contact/call tools, wires stdio transport
  db.js       SQLite storage (better-sqlite3): contacts + cached call reports (batch + outcome columns)
  twilio.js   Twilio SMS client
  vapi.js     Vapi call client + system-prompt builder
  auth.js     Dashboard session auth (bcrypt login, signed-cookie sessions)
  trigger.js  Inbound trigger endpoint: bearer auth, rate limit, out-of-hours queue
  callhours.js   Business-hours window parsing + timezone evaluation
  webhook.js  Express server (port 3117): Vapi webhook + dashboard + /api routes
  dashboard.js   Loads and serves the dashboard + login HTML
  dashboard.html Self-contained dark-theme dashboard (HTML/CSS/JS)
  login.html     Self-contained login page
scripts/
  hash-password.js  Generate a bcrypt hash for DASHBOARD_PASSWORD_HASH
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
