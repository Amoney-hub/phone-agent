import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve .env relative to this source file, not the process cwd — Claude
// Desktop launches the server from a different working directory. Hosted
// platforms inject env vars directly (no .env file), so guard against any
// failure loading it.
try {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
} catch {
  /* platform provides env vars; ignore .env load failures */
}

// Default DB lives at the project root next to package.json.
const dbPath = process.env.PHONE_AGENT_DB
  ? path.resolve(process.env.PHONE_AGENT_DB)
  : path.join(__dirname, "..", "contacts.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  -- Tenants. Each contact/call/appointment/batch belongs to one client.
  CREATE TABLE IF NOT EXISTS clients (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    username       TEXT UNIQUE COLLATE NOCASE,
    password_hash  TEXT,
    outcome_values TEXT NOT NULL DEFAULT '{}',
    api_key        TEXT UNIQUE,
    tier           TEXT NOT NULL DEFAULT 'free',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER,
    name       TEXT NOT NULL COLLATE NOCASE,
    phone      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(client_id, name)
  );

  CREATE TABLE IF NOT EXISTS calls (
    call_id          TEXT PRIMARY KEY,
    client_id        INTEGER,
    batch_id         TEXT,
    status           TEXT,
    ended_reason     TEXT,
    summary          TEXT,
    transcript       TEXT,
    recording_url    TEXT,
    customer_number  TEXT,
    duration_seconds INTEGER,
    outcome          TEXT,
    callback_time    TEXT,
    notes            TEXT,
    source_tag       TEXT,
    objective        TEXT,
    objective_norm   TEXT,
    review_status    TEXT,
    placed_at        TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Batches of calls placed together (call_list / batch trigger).
  CREATE TABLE IF NOT EXISTS batches (
    batch_id   TEXT PRIMARY KEY,
    client_id  INTEGER,
    objective  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Booked jobs/shifts, derived from calls whose outcome is "booked".
  CREATE TABLE IF NOT EXISTS appointments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id      INTEGER,
    call_id        TEXT UNIQUE,
    contact_name   TEXT,
    phone          TEXT,
    scheduled_time TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Abuse signals raised for an account (e.g. the same objective blasted to
  -- many numbers, or a manual review flag). One row per (client, kind, detail).
  CREATE TABLE IF NOT EXISTS abuse_flags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER,
    kind       TEXT NOT NULL,
    detail     TEXT,
    count      INTEGER NOT NULL DEFAULT 1,
    resolved   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(client_id, kind, detail)
  );

  -- Calls received via the inbound trigger endpoint while outside business
  -- hours wait here until the call window reopens (see src/callhours.js).
  CREATE TABLE IF NOT EXISTS queued_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    objective  TEXT NOT NULL,
    tag        TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Developer API keys. A client may hold several. The raw secret is shown
  -- once at creation; only its SHA-256 hash is stored. key_prefix/last4
  -- give the dashboard something to display without the secret.
  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id    INTEGER NOT NULL,
    name         TEXT,
    key_hash     TEXT NOT NULL UNIQUE,
    key_prefix   TEXT,
    last4        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at   TEXT
  );

  -- SMS messages sent through the developer API (POST /v1/messages).
  CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    client_id    INTEGER,
    api_key_id   INTEGER,
    to_number    TEXT,
    body         TEXT,
    status       TEXT,
    provider_sid TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-action usage events for /v1/usage (calls + messages). Minutes are
  -- derived from the calls table's duration_seconds, not stored here.
  CREATE TABLE IF NOT EXISTS usage_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER,
    api_key_id INTEGER,
    kind       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One outbound-webhook configuration per client (URL + signing secret).
  CREATE TABLE IF NOT EXISTS webhooks (
    client_id  INTEGER PRIMARY KEY,
    url        TEXT,
    secret     TEXT,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Delivery attempts for outbound webhooks (observability / debugging).
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER,
    event       TEXT,
    url         TEXT,
    status_code INTEGER,
    ok          INTEGER,
    error       TEXT,
    attempts    INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Request log for the developer API (Developer tab shows status + latency).
  CREATE TABLE IF NOT EXISTS request_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER,
    api_key_id INTEGER,
    method     TEXT,
    path       TEXT,
    status     INTEGER,
    latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Email captures from the public /developers "coming soon" page.
  CREATE TABLE IF NOT EXISTS email_signups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE COLLATE NOCASE,
    source     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_api_keys_client ON api_keys(client_id);
  CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_client ON usage_events(client_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reqlog_client ON request_logs(client_id, created_at);
`);

// --- Migrations for databases created before multi-tenancy ------------------

const callColumns = new Set(
  db.prepare(`PRAGMA table_info(calls)`).all().map((c) => c.name)
);
for (const [col, type] of [
  ["customer_number", "TEXT"],
  ["duration_seconds", "INTEGER"],
  ["batch_id", "TEXT"],
  ["outcome", "TEXT"],
  ["callback_time", "TEXT"],
  ["notes", "TEXT"],
  ["source_tag", "TEXT"],
  ["client_id", "INTEGER"],
  ["objective", "TEXT"],
  ["objective_norm", "TEXT"],
  ["review_status", "TEXT"],
  ["placed_at", "TEXT"],
]) {
  if (!callColumns.has(col)) db.exec(`ALTER TABLE calls ADD COLUMN ${col} ${type};`);
}
// Backfill placed_at from updated_at so rate windows have a value for old rows.
db.exec(`UPDATE calls SET placed_at = updated_at WHERE placed_at IS NULL;`);

// Add columns introduced after the multi-tenancy tables existed.
const clientColumns = new Set(
  db.prepare(`PRAGMA table_info(clients)`).all().map((c) => c.name)
);
if (!clientColumns.has("api_key")) {
  db.exec(`ALTER TABLE clients ADD COLUMN api_key TEXT;`);
}
if (!clientColumns.has("tier")) {
  db.exec(`ALTER TABLE clients ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';`);
}
const queuedColumns = new Set(
  db.prepare(`PRAGMA table_info(queued_calls)`).all().map((c) => c.name)
);
if (!queuedColumns.has("client_id")) {
  db.exec(`ALTER TABLE queued_calls ADD COLUMN client_id INTEGER;`);
}

// Contacts predating multi-tenancy have a global UNIQUE(name) and no client_id.
// Rebuild the table so names are unique per client instead.
const contactColumns = new Set(
  db.prepare(`PRAGMA table_info(contacts)`).all().map((c) => c.name)
);
if (!contactColumns.has("client_id")) {
  db.exec(`
    CREATE TABLE contacts_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id  INTEGER,
      name       TEXT NOT NULL COLLATE NOCASE,
      phone      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(client_id, name)
    );
    INSERT INTO contacts_new (id, client_id, name, phone, created_at)
      SELECT id, NULL, name, phone, created_at FROM contacts;
    DROP TABLE contacts;
    ALTER TABLE contacts_new RENAME TO contacts;
  `);
}

// --- Default tenant + backfill ---------------------------------------------

/**
 * Ensure a "Default" client exists and return its id. Existing rows (from
 * before multi-tenancy) are backfilled to it so current behavior is unchanged.
 */
function ensureDefaultClient() {
  let row = db.prepare(`SELECT id FROM clients ORDER BY id ASC LIMIT 1`).get();
  if (!row) {
    const info = db
      .prepare(
        `INSERT INTO clients (name, username, outcome_values) VALUES ('Default', 'default', '{}')`
      )
      .run();
    row = { id: Number(info.lastInsertRowid) };
  }
  return row.id;
}

export const DEFAULT_CLIENT_ID = ensureDefaultClient();

db.prepare(`UPDATE contacts SET client_id = ? WHERE client_id IS NULL`).run(DEFAULT_CLIENT_ID);
db.prepare(`UPDATE calls SET client_id = ? WHERE client_id IS NULL`).run(DEFAULT_CLIENT_ID);
db.prepare(`UPDATE batches SET client_id = ? WHERE client_id IS NULL`).run(DEFAULT_CLIENT_ID);
db.prepare(`UPDATE appointments SET client_id = ? WHERE client_id IS NULL`).run(DEFAULT_CLIENT_ID);
// The platform owner's Default tenant is unlimited so the owner's own usage
// (MCP, global trigger key) is never rate-limited or classified.
db.prepare(`UPDATE clients SET tier = 'unlimited' WHERE id = ?`).run(DEFAULT_CLIENT_ID);

/** Generate a random per-client trigger API key. */
export function generateApiKey() {
  return "ck_" + crypto.randomBytes(24).toString("hex");
}

// Give every real (non-Default) client an API key if it lacks one, so per-client
// attribution works immediately. The Default client stays keyless — the global
// TRIGGER_API_KEY already attributes to it.
for (const row of db
  .prepare(`SELECT id FROM clients WHERE api_key IS NULL AND id != ?`)
  .all(DEFAULT_CLIENT_ID)) {
  db.prepare(`UPDATE clients SET api_key = ? WHERE id = ?`).run(generateApiKey(), row.id);
}

// --- Prepared-statement cache ----------------------------------------------

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

// Append a client scope to a query. `clientId == null` means "all clients"
// (admin, no filter); a number restricts to that tenant.
function scoped(sql, clientId, { where = false, table = "" } = {}) {
  if (clientId == null) return sql;
  const col = table ? `${table}.client_id` : "client_id";
  return `${sql} ${where ? "WHERE" : "AND"} ${col} = @clientId`;
}
function bind(clientId, extra = {}) {
  return clientId == null ? extra : { ...extra, clientId };
}

// --- Contacts ---------------------------------------------------------------

export function addContact(name, phone, clientId = DEFAULT_CLIENT_ID) {
  return prep(`
    INSERT INTO contacts (client_id, name, phone) VALUES (@clientId, @name, @phone)
    ON CONFLICT(client_id, name) DO UPDATE SET phone = excluded.phone
    RETURNING *;
  `).get({ clientId, name, phone });
}

export function getContact(name, clientId = DEFAULT_CLIENT_ID) {
  return prep(
    `SELECT * FROM contacts WHERE name = @name COLLATE NOCASE AND client_id = @clientId;`
  ).get({ name, clientId });
}

export function listContacts(clientId = null) {
  const sql = scoped(
    `SELECT * FROM contacts`,
    clientId,
    { where: true }
  ) + ` ORDER BY name COLLATE NOCASE;`;
  return clientId == null ? prep(sql).all() : prep(sql).all({ clientId });
}

export function getContactById(id, clientId = null) {
  const sql = scoped(`SELECT * FROM contacts WHERE id = @id`, clientId);
  return prep(sql).get(bind(clientId, { id }));
}

export function updateContact(id, name, phone) {
  return prep(`
    UPDATE contacts SET name = @name, phone = @phone WHERE id = @id
    RETURNING *;
  `).get({ id, name, phone });
}

export function deleteContact(id, clientId = null) {
  const sql = scoped(`DELETE FROM contacts WHERE id = @id`, clientId);
  return prep(sql).run(bind(clientId, { id })).changes > 0;
}

// --- Calls ------------------------------------------------------------------

/**
 * Insert or update a stored call report (from the Vapi end-of-call webhook).
 * Never overwrites an existing client_id; when the row is new it defaults to
 * the Default client. Also records an appointment when the outcome is booked.
 */
export function saveCallReport({
  callId,
  status = null,
  endedReason = null,
  summary = null,
  transcript = null,
  recordingUrl = null,
  customerNumber = null,
  durationSeconds = null,
  outcome = null,
  callbackTime = null,
  notes = null,
}) {
  const row = prep(`
    INSERT INTO calls
      (call_id, client_id, status, ended_reason, summary, transcript, recording_url,
       customer_number, duration_seconds, outcome, callback_time, notes, placed_at, updated_at)
    VALUES
      (@call_id, @client_id, @status, @ended_reason, @summary, @transcript, @recording_url,
       @customer_number, @duration_seconds, @outcome, @callback_time, @notes, datetime('now'), datetime('now'))
    ON CONFLICT(call_id) DO UPDATE SET
      status           = excluded.status,
      ended_reason     = excluded.ended_reason,
      summary          = excluded.summary,
      transcript       = excluded.transcript,
      recording_url    = excluded.recording_url,
      customer_number  = COALESCE(excluded.customer_number, calls.customer_number),
      duration_seconds = excluded.duration_seconds,
      outcome          = excluded.outcome,
      callback_time    = excluded.callback_time,
      notes            = excluded.notes,
      -- Preserve the tenant recorded at placement time.
      client_id        = COALESCE(calls.client_id, excluded.client_id),
      updated_at       = excluded.updated_at
    RETURNING *;
  `).get({
    call_id: callId,
    client_id: DEFAULT_CLIENT_ID,
    status,
    ended_reason: endedReason,
    summary,
    transcript,
    recording_url: recordingUrl,
    customer_number: customerNumber,
    duration_seconds: durationSeconds,
    outcome,
    callback_time: callbackTime,
    notes,
  });

  // A booked call becomes an appointment (idempotent on call_id).
  if (row && row.outcome === "booked") {
    const contact = row.customer_number
      ? prep(
          `SELECT name FROM contacts WHERE phone = @phone AND client_id = @clientId;`
        ).get({ phone: row.customer_number, clientId: row.client_id })
      : null;
    recordAppointment({
      clientId: row.client_id,
      callId: row.call_id,
      contactName: contact?.name ?? null,
      phone: row.customer_number,
      scheduledTime: row.callback_time,
    });
  }
  return row;
}

/**
 * Record a call at placement time (from make_call / call_list), storing its
 * tenant and batch before any webhook report arrives.
 */
export function recordPlacedCall({
  callId,
  batchId = null,
  customerNumber = null,
  status = "queued",
  sourceTag = null,
  clientId = DEFAULT_CLIENT_ID,
  objective = null,
  objectiveNorm = null,
  reviewStatus = null,
}) {
  return prep(`
    INSERT INTO calls
      (call_id, client_id, batch_id, customer_number, status, source_tag,
       objective, objective_norm, review_status, placed_at, updated_at)
    VALUES
      (@call_id, @client_id, @batch_id, @customer_number, @status, @source_tag,
       @objective, @objective_norm, @review_status, datetime('now'), datetime('now'))
    ON CONFLICT(call_id) DO UPDATE SET
      client_id       = COALESCE(calls.client_id, excluded.client_id),
      batch_id        = COALESCE(excluded.batch_id, calls.batch_id),
      customer_number = COALESCE(excluded.customer_number, calls.customer_number),
      status          = COALESCE(excluded.status, calls.status),
      source_tag      = COALESCE(excluded.source_tag, calls.source_tag),
      objective       = COALESCE(calls.objective, excluded.objective),
      objective_norm  = COALESCE(calls.objective_norm, excluded.objective_norm),
      review_status   = COALESCE(calls.review_status, excluded.review_status),
      placed_at       = COALESCE(calls.placed_at, excluded.placed_at),
      updated_at      = excluded.updated_at
    RETURNING *;
  `).get({
    call_id: callId,
    client_id: clientId,
    batch_id: batchId,
    customer_number: customerNumber,
    status,
    source_tag: sourceTag,
    objective,
    objective_norm: objectiveNorm,
    review_status: reviewStatus,
  });
}

/** Look up a stored call by id, optionally scoped to a tenant. */
export function getStoredCall(callId, clientId = null) {
  const sql = scoped(`SELECT * FROM calls WHERE call_id = @callId`, clientId);
  return prep(sql).get(bind(clientId, { callId }));
}

/** All calls in a batch (newest-placed first), with contact name resolved. */
export function getBatchCalls(batchId, clientId = null) {
  const sql =
    scoped(
      `SELECT calls.*, contacts.name AS contact_name
       FROM calls
       LEFT JOIN contacts ON contacts.phone = calls.customer_number
                          AND contacts.client_id = calls.client_id
       WHERE calls.batch_id = @batchId`,
      clientId,
      { table: "calls" }
    ) + ` ORDER BY calls.updated_at ASC;`;
  return prep(sql).all(bind(clientId, { batchId }));
}

/** Call history, newest first, with resolved contact name. Optionally scoped. */
export function listCalls(clientId = null) {
  const sql =
    scoped(
      `SELECT calls.*, contacts.name AS contact_name
       FROM calls
       LEFT JOIN contacts ON contacts.phone = calls.customer_number
                          AND contacts.client_id = calls.client_id`,
      clientId,
      { where: true, table: "calls" }
    ) + ` ORDER BY calls.updated_at DESC;`;
  return clientId == null ? prep(sql).all() : prep(sql).all({ clientId });
}

// --- Batches ----------------------------------------------------------------

export function recordBatch({ batchId, clientId = DEFAULT_CLIENT_ID, objective = null }) {
  return prep(`
    INSERT INTO batches (batch_id, client_id, objective) VALUES (@batchId, @clientId, @objective)
    ON CONFLICT(batch_id) DO NOTHING;
  `).run({ batchId, clientId, objective });
}

/** A batch row, scoped. Note: `objective` is admin-only (never sent to clients). */
export function getBatch(batchId, clientId = null) {
  const sql = scoped(`SELECT * FROM batches WHERE batch_id = @batchId`, clientId);
  return prep(sql).get(bind(clientId, { batchId }));
}

// --- Appointments -----------------------------------------------------------

export function recordAppointment({
  clientId = DEFAULT_CLIENT_ID,
  callId,
  contactName = null,
  phone = null,
  scheduledTime = null,
}) {
  return prep(`
    INSERT INTO appointments (client_id, call_id, contact_name, phone, scheduled_time)
    VALUES (@clientId, @callId, @contactName, @phone, @scheduledTime)
    ON CONFLICT(call_id) DO UPDATE SET
      contact_name   = excluded.contact_name,
      phone          = excluded.phone,
      scheduled_time = excluded.scheduled_time;
  `).run({ clientId, callId, contactName, phone, scheduledTime });
}

export function listAppointments(clientId = null) {
  const sql = scoped(`SELECT * FROM appointments`, clientId, { where: true }) +
    ` ORDER BY created_at DESC;`;
  return clientId == null ? prep(sql).all() : prep(sql).all({ clientId });
}

// --- Metrics ----------------------------------------------------------------

/**
 * Per-(client, outcome) call counts, optionally scoped to one tenant. Used to
 * build the client results header and outcome breakdown.
 */
export function outcomeCounts(clientId = null) {
  const sql = scoped(
    `SELECT client_id, outcome, COUNT(*) AS n FROM calls WHERE outcome IS NOT NULL`,
    clientId
  ) + ` GROUP BY client_id, outcome;`;
  return clientId == null ? prep(sql).all() : prep(sql).all({ clientId });
}

/** Total number of calls, optionally scoped. */
export function countCalls(clientId = null) {
  const sql = scoped(`SELECT COUNT(*) AS n FROM calls`, clientId, { where: true });
  const row = clientId == null ? prep(sql).get() : prep(sql).get({ clientId });
  return row.n;
}

// --- Clients ----------------------------------------------------------------

function parseValues(json) {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Admin view of a client row. Includes the per-client `api_key` — this is only
 * ever returned to admins (client-facing routes select just id/name).
 */
function clientView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    has_login: Boolean(row.password_hash),
    outcome_values: parseValues(row.outcome_values),
    api_key: row.api_key || null,
    tier: row.tier || "free",
    created_at: row.created_at,
  };
}

export function createClient({
  name,
  username = null,
  passwordHash = null,
  outcomeValues = {},
  apiKey = generateApiKey(),
  tier = "free",
}) {
  const info = prep(`
    INSERT INTO clients (name, username, password_hash, outcome_values, api_key, tier)
    VALUES (@name, @username, @passwordHash, @outcomeValues, @apiKey, @tier)
  `).run({
    name,
    username,
    passwordHash,
    outcomeValues: JSON.stringify(outcomeValues || {}),
    apiKey,
    tier,
  });
  return clientView(getClientRow(Number(info.lastInsertRowid)));
}

// --- Tiers & usage counters (abuse limits) ---------------------------------

export function getClientTier(id) {
  const row = getClientRow(id);
  return (row && row.tier) || "free";
}

export function setClientTier(id, tier) {
  prep(`UPDATE clients SET tier = @tier WHERE id = @id;`).run({ id, tier });
  return getClientById(id);
}

/** Calls a client placed within a rolling window (e.g. mod = '-1 day'). */
export function callsPlacedSince(clientId, mod) {
  return prep(
    `SELECT COUNT(*) AS n FROM calls WHERE client_id = @clientId AND placed_at >= datetime('now', @mod);`
  ).get({ clientId, mod }).n;
}

/** Distinct numbers a client has dialed within a rolling window. */
export function distinctNumbersSince(clientId, mod) {
  return prep(
    `SELECT COUNT(DISTINCT customer_number) AS n FROM calls
     WHERE client_id = @clientId AND customer_number IS NOT NULL AND placed_at >= datetime('now', @mod);`
  ).get({ clientId, mod }).n;
}

/** Whether a client has already dialed a number within a rolling window. */
export function numberCalledSince(clientId, phone, mod) {
  return Boolean(
    prep(
      `SELECT 1 FROM calls WHERE client_id = @clientId AND customer_number = @phone
       AND placed_at >= datetime('now', @mod) LIMIT 1;`
    ).get({ clientId, phone, mod })
  );
}

/**
 * Groups of calls that share the same normalized objective sent to many
 * distinct numbers within a window — the "spray the same script" signal.
 */
export function repeatObjectiveGroups(clientId, mod, threshold) {
  return prep(
    `SELECT objective_norm, COUNT(DISTINCT customer_number) AS numbers, COUNT(*) AS calls
     FROM calls
     WHERE client_id = @clientId AND objective_norm IS NOT NULL AND objective_norm != ''
       AND placed_at >= datetime('now', @mod)
     GROUP BY objective_norm
     HAVING numbers >= @threshold
     ORDER BY numbers DESC;`
  ).all({ clientId, mod, threshold });
}

// --- Abuse flags ------------------------------------------------------------

export function addAbuseFlag({ clientId, kind, detail = null, count = 1 }) {
  prep(`
    INSERT INTO abuse_flags (client_id, kind, detail, count)
    VALUES (@clientId, @kind, @detail, @count)
    ON CONFLICT(client_id, kind, detail) DO UPDATE SET
      count = excluded.count, resolved = 0, updated_at = datetime('now');
  `).run({ clientId, kind, detail, count });
}

export function listAbuseFlags({ resolved = false } = {}) {
  return prep(`
    SELECT abuse_flags.*, clients.name AS client_name, clients.tier AS client_tier
    FROM abuse_flags LEFT JOIN clients ON clients.id = abuse_flags.client_id
    WHERE abuse_flags.resolved = @resolved
    ORDER BY abuse_flags.updated_at DESC;
  `).all({ resolved: resolved ? 1 : 0 });
}

export function resolveAbuseFlag(id) {
  return prep(`UPDATE abuse_flags SET resolved = 1, updated_at = datetime('now') WHERE id = ?;`)
    .run(id).changes > 0;
}

export function countUnresolvedFlags() {
  return prep(`SELECT COUNT(*) AS n FROM abuse_flags WHERE resolved = 0;`).get().n;
}

// --- Review queue (new accounts' first calls) ------------------------------

/** Calls awaiting admin review, newest first, with account + objective. */
export function listReviewQueue() {
  return prep(`
    SELECT calls.call_id, calls.client_id, calls.customer_number, calls.objective,
           calls.status, calls.ended_reason, calls.outcome, calls.summary,
           calls.transcript, calls.recording_url, calls.duration_seconds,
           calls.placed_at, calls.updated_at,
           clients.name AS client_name, clients.tier AS client_tier,
           contacts.name AS contact_name
    FROM calls
    LEFT JOIN clients ON clients.id = calls.client_id
    LEFT JOIN contacts ON contacts.phone = calls.customer_number AND contacts.client_id = calls.client_id
    WHERE calls.review_status = 'pending'
    ORDER BY calls.placed_at DESC;
  `).all();
}

export function countReviewQueue() {
  return prep(`SELECT COUNT(*) AS n FROM calls WHERE review_status = 'pending';`).get().n;
}

export function setCallReviewStatus(callId, status) {
  return prep(`UPDATE calls SET review_status = @status WHERE call_id = @callId;`)
    .run({ callId, status }).changes > 0;
}

function getClientRow(id) {
  return prep(`SELECT * FROM clients WHERE id = ?;`).get(id);
}

/** Raw client row by exact API key (includes secrets) — for auth only. */
export function getClientByApiKey(apiKey) {
  if (!apiKey) return undefined;
  return prep(`SELECT * FROM clients WHERE api_key = ?;`).get(apiKey);
}

/** Admin view of a client by name (case-insensitive). */
export function getClientByName(name) {
  return clientView(prep(`SELECT * FROM clients WHERE name = ? COLLATE NOCASE;`).get(name));
}

/**
 * Resolve a client reference (numeric id, numeric string, or name) to a client
 * id, or null if it doesn't match a client. Used by the MCP `client` parameter.
 */
export function resolveClientId(ref) {
  if (ref == null || ref === "") return null;
  if (typeof ref === "number" && Number.isInteger(ref)) {
    return getClientRow(ref) ? ref : null;
  }
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const id = Number(s);
    return getClientRow(id) ? id : null;
  }
  const byName = prep(`SELECT id FROM clients WHERE name = ? COLLATE NOCASE;`).get(s);
  return byName ? byName.id : null;
}

/** Rotate a client's API key and return the fresh admin view. */
export function regenerateClientApiKey(id) {
  const key = generateApiKey();
  prep(`UPDATE clients SET api_key = @key WHERE id = @id;`).run({ id, key });
  return getClientById(id);
}

/**
 * Delete a client and ALL of its data (contacts, calls, appointments, batches,
 * queued calls) in one transaction. The Default client cannot be deleted.
 * Returns true if a client row was removed.
 */
const deleteClientTx = db.transaction((id) => {
  db.prepare(`DELETE FROM appointments WHERE client_id = ?`).run(id);
  db.prepare(`DELETE FROM calls WHERE client_id = ?`).run(id);
  db.prepare(`DELETE FROM batches WHERE client_id = ?`).run(id);
  db.prepare(`DELETE FROM contacts WHERE client_id = ?`).run(id);
  db.prepare(`DELETE FROM queued_calls WHERE client_id = ?`).run(id);
  return db.prepare(`DELETE FROM clients WHERE id = ?`).run(id).changes > 0;
});

export function deleteClient(id) {
  if (Number(id) === DEFAULT_CLIENT_ID) {
    throw new Error("The Default client cannot be deleted.");
  }
  return deleteClientTx(id);
}

export function getClientById(id) {
  return clientView(getClientRow(id));
}

/** Raw client row by username (includes password_hash) — for auth only. */
export function getClientAuthByUsername(username) {
  return prep(`SELECT * FROM clients WHERE username = ? COLLATE NOCASE;`).get(username);
}

export function listClients() {
  return prep(`SELECT * FROM clients ORDER BY name COLLATE NOCASE;`).all().map(clientView);
}

export function setClientOutcomeValues(id, valuesObj) {
  prep(`UPDATE clients SET outcome_values = @v WHERE id = @id;`).run({
    id,
    v: JSON.stringify(valuesObj || {}),
  });
  return getClientById(id);
}

export function getClientOutcomeValues(id) {
  const row = getClientRow(id);
  return row ? parseValues(row.outcome_values) : {};
}

export function setClientLogin(id, username, passwordHash) {
  prep(`UPDATE clients SET username = @username, password_hash = @passwordHash WHERE id = @id;`).run(
    { id, username, passwordHash }
  );
  return getClientById(id);
}

export function getDefaultClientId() {
  return DEFAULT_CLIENT_ID;
}

// --- Queued (out-of-hours) trigger calls ------------------------------------

export function enqueueCall({ name, phone, objective, tag = null, clientId = DEFAULT_CLIENT_ID }) {
  return prep(`
    INSERT INTO queued_calls (client_id, name, phone, objective, tag)
    VALUES (@clientId, @name, @phone, @objective, @tag)
    RETURNING *;
  `).get({ clientId, name, phone, objective, tag });
}

export function listQueuedCalls() {
  return prep(`SELECT * FROM queued_calls ORDER BY id ASC;`).all();
}

export function deleteQueuedCall(id) {
  return prep(`DELETE FROM queued_calls WHERE id = ?;`).run(id).changes > 0;
}

export function countQueuedCalls() {
  return prep(`SELECT COUNT(*) AS n FROM queued_calls;`).get().n;
}

// --- Developer API keys -----------------------------------------------------

const sha256hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** Generate a fresh raw developer key. Same `ck_` scheme as the legacy key. */
export function generateRawApiKey() {
  return "ck_" + crypto.randomBytes(24).toString("hex");
}

/** Public shape of an api_keys row — never includes the hash or raw secret. */
function apiKeyView(row) {
  if (!row) return null;
  return {
    id: row.id,
    client_id: row.client_id,
    client_name: row.client_name ?? null,
    name: row.name || null,
    // e.g. "ck_1a2b3c4d…7f9e" — enough to recognize a key, useless as a secret.
    masked: `${row.key_prefix || "ck_"}…${row.last4 || ""}`,
    prefix: row.key_prefix || null,
    last4: row.last4 || null,
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
    revoked: Boolean(row.revoked_at),
    revoked_at: row.revoked_at || null,
  };
}

/**
 * Create a developer key for a client. Returns the public view PLUS the raw
 * `key` — the only time the caller ever sees the full secret.
 */
export function createApiKey(clientId, name = null) {
  const raw = generateRawApiKey();
  const info = prep(`
    INSERT INTO api_keys (client_id, name, key_hash, key_prefix, last4)
    VALUES (@clientId, @name, @hash, @prefix, @last4)
  `).run({
    clientId,
    name: name ? String(name).trim() : null,
    hash: sha256hex(raw),
    prefix: raw.slice(0, 11),
    last4: raw.slice(-4),
  });
  const view = apiKeyView(prep(`SELECT * FROM api_keys WHERE id = ?;`).get(Number(info.lastInsertRowid)));
  return { ...view, key: raw };
}

/** List a client's keys (or all keys, with client name, when clientId is null). */
export function listApiKeys(clientId = null) {
  if (clientId == null) {
    return prep(`
      SELECT api_keys.*, clients.name AS client_name
      FROM api_keys LEFT JOIN clients ON clients.id = api_keys.client_id
      ORDER BY api_keys.created_at DESC;
    `).all().map(apiKeyView);
  }
  return prep(`SELECT * FROM api_keys WHERE client_id = ? ORDER BY created_at DESC;`)
    .all(clientId).map(apiKeyView);
}

export function getApiKeyById(id) {
  return apiKeyView(prep(`SELECT * FROM api_keys WHERE id = ?;`).get(id));
}

/** Revoke a key (idempotent). Returns true if a live key was revoked. */
export function revokeApiKey(id) {
  return prep(`UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL;`)
    .run(id).changes > 0;
}

/**
 * Rotate a key: revoke the old one and mint a new key for the same client,
 * carrying over the label. Returns the new key (with raw secret) or null.
 */
export function rotateApiKey(id) {
  const row = prep(`SELECT * FROM api_keys WHERE id = ?;`).get(id);
  if (!row) return null;
  revokeApiKey(id);
  return createApiKey(row.client_id, row.name);
}

/**
 * Resolve a raw bearer token to `{ client_id, api_key_id }` using the api_keys
 * table (hashed lookup), or the legacy per-client `clients.api_key`. Ignores
 * revoked keys. Touches last_used_at on a hit. Returns null when unrecognized.
 */
export function resolveApiKey(token) {
  if (!token) return null;
  const row = prep(`SELECT id, client_id, revoked_at FROM api_keys WHERE key_hash = ?;`)
    .get(sha256hex(token));
  if (row && !row.revoked_at) {
    prep(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?;`).run(row.id);
    return { client_id: row.client_id, api_key_id: row.id };
  }
  // Legacy single key stored raw on the client row.
  const legacy = prep(`SELECT id FROM clients WHERE api_key = ?;`).get(token);
  if (legacy) return { client_id: legacy.id, api_key_id: null };
  return null;
}

// --- Messages ---------------------------------------------------------------

export function recordMessage({
  id,
  clientId = null,
  apiKeyId = null,
  to = null,
  body = null,
  status = null,
  providerSid = null,
  error = null,
}) {
  return prep(`
    INSERT INTO messages (id, client_id, api_key_id, to_number, body, status, provider_sid, error)
    VALUES (@id, @clientId, @apiKeyId, @to, @body, @status, @providerSid, @error)
    RETURNING *;
  `).get({ id, clientId, apiKeyId, to, body, status, providerSid, error });
}

export function getMessage(id, clientId = null) {
  const sql = scoped(`SELECT * FROM messages WHERE id = @id`, clientId);
  return prep(sql).get(bind(clientId, { id }));
}

export function listMessages(clientId = null, { limit = 50, offset = 0 } = {}) {
  const sql =
    scoped(`SELECT * FROM messages`, clientId, { where: true }) +
    ` ORDER BY created_at DESC LIMIT @limit OFFSET @offset;`;
  return prep(sql).all(bind(clientId, { limit, offset }));
}

// --- Usage ------------------------------------------------------------------

export function recordUsage({ clientId = null, apiKeyId = null, kind }) {
  prep(`INSERT INTO usage_events (client_id, api_key_id, kind) VALUES (@clientId, @apiKeyId, @kind);`)
    .run({ clientId, apiKeyId, kind });
}

/**
 * Usage summary over a rolling window (SQLite modifier, e.g. '-30 days'; null =
 * all time). `clientId` null aggregates across all clients (admin overview).
 * Calls + minutes come from the calls table so completed-call durations are
 * reflected; messages from the messages table.
 */
export function usageSummary(clientId = null, mod = null) {
  const clientClause = (col) => (clientId != null ? ` AND ${col} = @clientId` : "");
  const p = {};
  if (clientId != null) p.clientId = clientId;
  if (mod) p.mod = mod;
  const calls = prep(
    `SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS secs
     FROM calls WHERE 1=1${clientClause("client_id")}${mod ? " AND placed_at >= datetime('now', @mod)" : ""};`
  ).get(p);
  const messages = prep(
    `SELECT COUNT(*) AS n FROM messages WHERE 1=1${clientClause("client_id")}${mod ? " AND created_at >= datetime('now', @mod)" : ""};`
  ).get(p);
  return {
    calls: calls.n,
    minutes: Math.round((calls.secs / 60) * 10) / 10,
    messages: messages.n,
  };
}

/**
 * Daily call counts + minutes for the last `days` days (for the usage chart).
 * `clientId` null aggregates across all clients.
 */
export function usageDaily(clientId = null, days = 14) {
  const clientClause = clientId != null ? ` AND client_id = @clientId` : "";
  const p = { mod: `-${Number(days)} days` };
  if (clientId != null) p.clientId = clientId;
  return prep(`
    SELECT date(placed_at) AS day, COUNT(*) AS calls,
           COALESCE(SUM(duration_seconds), 0) AS secs
    FROM calls
    WHERE placed_at >= datetime('now', @mod)${clientClause}
    GROUP BY date(placed_at) ORDER BY day ASC;
  `).all(p);
}

// --- Outbound webhook config ------------------------------------------------

export function getWebhook(clientId) {
  return prep(`SELECT * FROM webhooks WHERE client_id = ?;`).get(clientId) || null;
}

/**
 * Upsert a client's webhook config. Generates a signing secret the first time
 * one is set. Passing `rotateSecret: true` mints a new secret.
 */
export function setWebhook(clientId, { url = null, enabled = true, rotateSecret = false } = {}) {
  const existing = getWebhook(clientId);
  const secret =
    rotateSecret || !existing || !existing.secret
      ? "whsec_" + crypto.randomBytes(24).toString("hex")
      : existing.secret;
  prep(`
    INSERT INTO webhooks (client_id, url, secret, enabled, updated_at)
    VALUES (@clientId, @url, @secret, @enabled, datetime('now'))
    ON CONFLICT(client_id) DO UPDATE SET
      url = excluded.url, secret = excluded.secret,
      enabled = excluded.enabled, updated_at = datetime('now');
  `).run({ clientId, url, secret, enabled: enabled ? 1 : 0 });
  return getWebhook(clientId);
}

export function recordWebhookDelivery({
  clientId = null,
  event = null,
  url = null,
  statusCode = null,
  ok = false,
  error = null,
  attempts = 1,
}) {
  prep(`
    INSERT INTO webhook_deliveries (client_id, event, url, status_code, ok, error, attempts)
    VALUES (@clientId, @event, @url, @statusCode, @ok, @error, @attempts);
  `).run({ clientId, event, url, statusCode, ok: ok ? 1 : 0, error, attempts });
}

export function listWebhookDeliveries(clientId = null, limit = 50) {
  const sql =
    scoped(`SELECT * FROM webhook_deliveries`, clientId, { where: true }) +
    ` ORDER BY created_at DESC LIMIT @limit;`;
  return prep(sql).all(bind(clientId, { limit }));
}

// --- Request logs -----------------------------------------------------------

// Keep the log bounded so it never grows without limit.
const REQUEST_LOG_CAP = Number(process.env.REQUEST_LOG_CAP || 5000);

export function recordRequestLog({
  clientId = null,
  apiKeyId = null,
  method,
  path,
  status,
  latencyMs,
}) {
  prep(`
    INSERT INTO request_logs (client_id, api_key_id, method, path, status, latency_ms)
    VALUES (@clientId, @apiKeyId, @method, @path, @status, @latencyMs);
  `).run({ clientId, apiKeyId, method, path, status, latencyMs });
  // Opportunistic prune: drop the oldest rows past the cap.
  prep(`
    DELETE FROM request_logs WHERE id IN (
      SELECT id FROM request_logs ORDER BY id DESC LIMIT -1 OFFSET @cap
    );
  `).run({ cap: REQUEST_LOG_CAP });
}

export function listRequestLogs(clientId = null, { limit = 100 } = {}) {
  const sql =
    scoped(
      `SELECT request_logs.*, clients.name AS client_name
       FROM request_logs LEFT JOIN clients ON clients.id = request_logs.client_id`,
      clientId,
      { where: true, table: "request_logs" }
    ) + ` ORDER BY request_logs.id DESC LIMIT @limit;`;
  return prep(sql).all(bind(clientId, { limit }));
}

// --- Email signups (public /developers) -------------------------------------

export function addEmailSignup(email, source = "developers") {
  return prep(`
    INSERT INTO email_signups (email, source) VALUES (@email, @source)
    ON CONFLICT(email) DO NOTHING;
  `).run({ email: String(email).trim(), source }).changes > 0;
}

export function listEmailSignups() {
  return prep(`SELECT * FROM email_signups ORDER BY created_at DESC;`).all();
}

export function countEmailSignups() {
  return prep(`SELECT COUNT(*) AS n FROM email_signups;`).get().n;
}

export default db;
