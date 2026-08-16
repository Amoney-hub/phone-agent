// HTTP client for the hosted phone-agent API. Used by the MCP server when
// REMOTE_API_URL is set, so contacts and call records live in one place (the
// Railway database) instead of a separate local SQLite file.
//
// Authenticates with TRIGGER_API_KEY as a bearer token — the same key the
// hosted server accepts on its /api routes (see src/auth.js hasValidBearer).

function baseUrl() {
  const url = process.env.REMOTE_API_URL;
  if (!url) throw new Error("REMOTE_API_URL is not set.");
  return url.replace(/\/+$/, "");
}

function authHeaders() {
  const key = process.env.TRIGGER_API_KEY;
  if (!key) {
    throw new Error(
      "REMOTE_API_URL is set but TRIGGER_API_KEY is missing — the hosted API needs a bearer token. Set TRIGGER_API_KEY to the same value configured on the server."
    );
  }
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function apiRequest(method, path, body) {
  let res;
  try {
    res = await fetch(baseUrl() + path, {
      method,
      headers: authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Could not reach hosted API (${method} ${path}): ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(`Hosted API ${method} ${path} failed: ${detail}`);
  }
  return data;
}

// Thin wrappers over the hosted routes.
export const remote = {
  addContact: (name, phone) => apiRequest("POST", "/api/contacts", { name, phone }),
  listContacts: () => apiRequest("GET", "/api/contacts"),
  placeCall: (name, objective, voicemailMessage) =>
    apiRequest("POST", "/api/calls", { name, objective, voicemail_message: voicemailMessage }),
  placeBatch: (names, objective, voicemailMessage) =>
    apiRequest("POST", "/api/calls/batch", { names, objective, voicemail_message: voicemailMessage }),
  getCallResult: (callId) =>
    apiRequest("GET", `/api/calls/${encodeURIComponent(callId)}`),
  getBatchResult: (batchId) =>
    apiRequest("GET", `/api/calls/batch/${encodeURIComponent(batchId)}`),
};

/**
 * Backend implementation that proxies every operation to the hosted API. Shape
 * matches the local backend in src/index.js so the tool handlers are identical.
 */
export function makeRemoteBackend() {
  return {
    mode: "remote",
    async addContact(name, phone) {
      const c = await remote.addContact(name, phone);
      return { name: c.name, phone: c.phone };
    },
    async getContactByName(name) {
      const list = await remote.listContacts();
      const found = list.find(
        (c) => String(c.name).toLowerCase() === String(name).toLowerCase()
      );
      return found ? { name: found.name, phone: found.phone } : null;
    },
    placeCall: (name, objective, vm) => remote.placeCall(name, objective, vm),
    placeBatch: (names, objective, vm) => remote.placeBatch(names, objective, vm),
    getCallResult: (callId) => remote.getCallResult(callId),
    getBatchResult: (batchId) => remote.getBatchResult(batchId),
  };
}
