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

// The absolute SQLite file actually opened by this process. Exported so a
// diagnostic route can confirm PHONE_AGENT_DB / a mounted volume is being used.
export const DB_PATH = dbPath;

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
]) {
  if (!callColumns.has(col)) db.exec(`ALTER TABLE calls ADD COLUMN ${col} ${type};`);
}

// Add columns introduced after the multi-tenancy tables existed.
const clientColumns = new Set(
  db.prepare(`PRAGMA table_info(clients)`).all().map((c) => c.name)
);
if (!clientColumns.has("api_key")) {
  db.exec(`ALTER TABLE clients ADD COLUMN api_key TEXT;`);
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
       customer_number, duration_seconds, outcome, callback_time, notes, updated_at)
    VALUES
      (@call_id, @client_id, @status, @ended_reason, @summary, @transcript, @recording_url,
       @customer_number, @duration_seconds, @outcome, @callback_time, @notes, datetime('now'))
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
}) {
  return prep(`
    INSERT INTO calls (call_id, client_id, batch_id, customer_number, status, source_tag, updated_at)
    VALUES (@call_id, @client_id, @batch_id, @customer_number, @status, @source_tag, datetime('now'))
    ON CONFLICT(call_id) DO UPDATE SET
      client_id       = COALESCE(calls.client_id, excluded.client_id),
      batch_id        = COALESCE(excluded.batch_id, calls.batch_id),
      customer_number = COALESCE(excluded.customer_number, calls.customer_number),
      status          = COALESCE(excluded.status, calls.status),
      source_tag      = COALESCE(excluded.source_tag, calls.source_tag),
      updated_at      = excluded.updated_at
    RETURNING *;
  `).get({
    call_id: callId,
    client_id: clientId,
    batch_id: batchId,
    customer_number: customerNumber,
    status,
    source_tag: sourceTag,
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
    created_at: row.created_at,
  };
}

export function createClient({
  name,
  username = null,
  passwordHash = null,
  outcomeValues = {},
  apiKey = generateApiKey(),
}) {
  const info = prep(`
    INSERT INTO clients (name, username, password_hash, outcome_values, api_key)
    VALUES (@name, @username, @passwordHash, @outcomeValues, @apiKey)
  `).run({
    name,
    username,
    passwordHash,
    outcomeValues: JSON.stringify(outcomeValues || {}),
    apiKey,
  });
  return clientView(getClientRow(Number(info.lastInsertRowid)));
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

export default db;
