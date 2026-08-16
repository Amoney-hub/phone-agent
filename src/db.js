import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve .env relative to this source file, not the process cwd — Claude
// Desktop launches the server from a different working directory.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Default DB lives at the project root next to package.json.
const dbPath = process.env.PHONE_AGENT_DB
  ? path.resolve(process.env.PHONE_AGENT_DB)
  : path.join(__dirname, "..", "contacts.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS calls (
    call_id          TEXT PRIMARY KEY,
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

  -- Calls received via the inbound trigger endpoint while outside business
  -- hours wait here until the call window reopens (see src/callhours.js).
  CREATE TABLE IF NOT EXISTS queued_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    objective  TEXT NOT NULL,
    tag        TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Lightweight migration for databases created before these columns existed.
const callColumns = new Set(
  db.prepare(`PRAGMA table_info(calls)`).all().map((c) => c.name)
);
if (!callColumns.has("customer_number")) {
  db.exec(`ALTER TABLE calls ADD COLUMN customer_number TEXT;`);
}
if (!callColumns.has("duration_seconds")) {
  db.exec(`ALTER TABLE calls ADD COLUMN duration_seconds INTEGER;`);
}
if (!callColumns.has("batch_id")) {
  db.exec(`ALTER TABLE calls ADD COLUMN batch_id TEXT;`);
}
// Structured outcome extracted by the Vapi analysis plan (see vapi.js).
if (!callColumns.has("outcome")) {
  db.exec(`ALTER TABLE calls ADD COLUMN outcome TEXT;`);
}
if (!callColumns.has("callback_time")) {
  db.exec(`ALTER TABLE calls ADD COLUMN callback_time TEXT;`);
}
if (!callColumns.has("notes")) {
  db.exec(`ALTER TABLE calls ADD COLUMN notes TEXT;`);
}
// Source tag for calls started via the inbound trigger endpoint.
if (!callColumns.has("source_tag")) {
  db.exec(`ALTER TABLE calls ADD COLUMN source_tag TEXT;`);
}

const statements = {
  upsert: db.prepare(`
    INSERT INTO contacts (name, phone) VALUES (@name, @phone)
    ON CONFLICT(name) DO UPDATE SET phone = excluded.phone
    RETURNING *;
  `),
  getByName: db.prepare(
    `SELECT * FROM contacts WHERE name = ? COLLATE NOCASE;`
  ),
  upsertCall: db.prepare(`
    INSERT INTO calls
      (call_id, status, ended_reason, summary, transcript, recording_url,
       customer_number, duration_seconds, outcome, callback_time, notes, updated_at)
    VALUES
      (@call_id, @status, @ended_reason, @summary, @transcript, @recording_url,
       @customer_number, @duration_seconds, @outcome, @callback_time, @notes, datetime('now'))
    ON CONFLICT(call_id) DO UPDATE SET
      status           = excluded.status,
      ended_reason     = excluded.ended_reason,
      summary          = excluded.summary,
      transcript       = excluded.transcript,
      recording_url    = excluded.recording_url,
      -- Preserve the number recorded at placement time if the report omits it.
      customer_number  = COALESCE(excluded.customer_number, calls.customer_number),
      duration_seconds = excluded.duration_seconds,
      outcome          = excluded.outcome,
      callback_time    = excluded.callback_time,
      notes            = excluded.notes,
      updated_at       = excluded.updated_at
    RETURNING *;
  `),
  // Record a call at placement time so its batch_id is stored before the
  // end-of-call webhook arrives. Deliberately does NOT touch report columns,
  // and preserves an existing batch_id / number if the row already exists.
  recordCall: db.prepare(`
    INSERT INTO calls (call_id, batch_id, customer_number, status, source_tag, updated_at)
    VALUES (@call_id, @batch_id, @customer_number, @status, @source_tag, datetime('now'))
    ON CONFLICT(call_id) DO UPDATE SET
      batch_id        = COALESCE(excluded.batch_id, calls.batch_id),
      customer_number = COALESCE(excluded.customer_number, calls.customer_number),
      status          = COALESCE(excluded.status, calls.status),
      source_tag      = COALESCE(excluded.source_tag, calls.source_tag),
      updated_at      = excluded.updated_at
    RETURNING *;
  `),
  getCallById: db.prepare(`SELECT * FROM calls WHERE call_id = ?;`),
  getCallsByBatch: db.prepare(`
    SELECT calls.*, contacts.name AS contact_name
    FROM calls
    LEFT JOIN contacts ON contacts.phone = calls.customer_number
    WHERE calls.batch_id = ?
    ORDER BY calls.updated_at ASC;
  `),
  listContacts: db.prepare(
    `SELECT * FROM contacts ORDER BY name COLLATE NOCASE;`
  ),
  getContactById: db.prepare(`SELECT * FROM contacts WHERE id = ?;`),
  updateContact: db.prepare(`
    UPDATE contacts SET name = @name, phone = @phone WHERE id = @id
    RETURNING *;
  `),
  deleteContact: db.prepare(`DELETE FROM contacts WHERE id = ?;`),
  // Newest first; join the contact name by matching the dialed number.
  listCalls: db.prepare(`
    SELECT calls.*, contacts.name AS contact_name
    FROM calls
    LEFT JOIN contacts ON contacts.phone = calls.customer_number
    ORDER BY calls.updated_at DESC;
  `),
  enqueueCall: db.prepare(`
    INSERT INTO queued_calls (name, phone, objective, tag)
    VALUES (@name, @phone, @objective, @tag)
    RETURNING *;
  `),
  listQueued: db.prepare(`SELECT * FROM queued_calls ORDER BY id ASC;`),
  deleteQueued: db.prepare(`DELETE FROM queued_calls WHERE id = ?;`),
  countQueued: db.prepare(`SELECT COUNT(*) AS n FROM queued_calls;`),
};

export function addContact(name, phone) {
  return statements.upsert.get({ name, phone });
}

export function getContact(name) {
  return statements.getByName.get(name);
}

/**
 * Insert or update a stored call report (from the Vapi end-of-call webhook).
 * Accepts a normalized report shape and returns the saved row.
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
  return statements.upsertCall.get({
    call_id: callId,
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
}

/**
 * Record a call at placement time (from make_call / call_list), storing its
 * batch_id and dialed number before any webhook report arrives.
 */
export function recordPlacedCall({
  callId,
  batchId = null,
  customerNumber = null,
  status = "queued",
  sourceTag = null,
}) {
  return statements.recordCall.get({
    call_id: callId,
    batch_id: batchId,
    customer_number: customerNumber,
    status,
    source_tag: sourceTag,
  });
}

/**
 * Look up a stored call by id. Returns the raw row (snake_case columns) or
 * undefined if we have not received a webhook report for it yet.
 */
export function getStoredCall(callId) {
  return statements.getCallById.get(callId);
}

/**
 * All calls belonging to a batch, newest-placed first, with contact name
 * resolved by dialed number.
 */
export function getBatchCalls(batchId) {
  return statements.getCallsByBatch.all(batchId);
}

// --- Dashboard helpers -----------------------------------------------------

export function listContacts() {
  return statements.listContacts.all();
}

export function getContactById(id) {
  return statements.getContactById.get(id);
}

export function updateContact(id, name, phone) {
  return statements.updateContact.get({ id, name, phone });
}

export function deleteContact(id) {
  return statements.deleteContact.run(id).changes > 0;
}

export function listCalls() {
  return statements.listCalls.all();
}

// --- Queued (out-of-hours) trigger calls ------------------------------------

/** Add a call to the out-of-hours queue. */
export function enqueueCall({ name, phone, objective, tag = null }) {
  return statements.enqueueCall.get({ name, phone, objective, tag });
}

/** All queued calls, oldest first (FIFO). */
export function listQueuedCalls() {
  return statements.listQueued.all();
}

/** Remove a queued call once it has been placed (or abandoned). */
export function deleteQueuedCall(id) {
  return statements.deleteQueued.run(id).changes > 0;
}

/** Count of calls currently waiting in the queue. */
export function countQueuedCalls() {
  return statements.countQueued.get().n;
}

export default db;
