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
    // A needs_info response (incomplete objective) is a normal outcome, not an
    // error — pass it through so make_call handles it the same as in local mode.
    if (data && data.needs_info) return data;
    const detail = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(`Hosted API ${method} ${path} failed: ${detail}`);
  }
  return data;
}

const clientBody = (client) => (client != null && client !== "" ? { client } : {});

// Thin wrappers over the hosted routes. `client` (name or id) attributes the
// operation to a specific tenant; the hosted API resolves it.
export const remote = {
  addContact: (name, phone, client) =>
    apiRequest("POST", "/api/contacts", { name, phone, ...clientBody(client) }),
  listContacts: (client) =>
    apiRequest("GET", "/api/contacts" + (client ? `?client=${encodeURIComponent(client)}` : "")),
  placeCall: (name, objective, voicemailMessage, client) =>
    apiRequest("POST", "/api/calls", {
      name,
      objective,
      voicemail_message: voicemailMessage,
      ...clientBody(client),
    }),
  placeBatch: (names, objective, voicemailMessage, client) =>
    apiRequest("POST", "/api/calls/batch", {
      names,
      objective,
      voicemail_message: voicemailMessage,
      ...clientBody(client),
    }),
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
    async addContact(name, phone, client) {
      const c = await remote.addContact(name, phone, client);
      return { name: c.name, phone: c.phone };
    },
    async getContactByName(name, client) {
      const list = await remote.listContacts(client);
      const found = list.find(
        (c) => String(c.name).toLowerCase() === String(name).toLowerCase()
      );
      return found ? { name: found.name, phone: found.phone } : null;
    },
    placeCall: (name, objective, vm, client) => remote.placeCall(name, objective, vm, client),
    placeBatch: (names, objective, vm, client) => remote.placeBatch(names, objective, vm, client),
    getCallResult: (callId) => remote.getCallResult(callId),
    getBatchResult: (batchId) => remote.getBatchResult(batchId),
  };
}
