#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Derive the directory of this source file. `import.meta.dirname` is only
// available on Node 20.11+, so fall back to deriving it from the file URL —
// otherwise `path.join(undefined, ...)` throws on older/hosted runtimes.
const __dirname =
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

// Resolve .env relative to this source file, not the process cwd — Claude
// Desktop launches the server from a different working directory. In hosted
// environments (e.g. Railway) env vars are injected directly and there is no
// .env file; dotenv treats a missing file as a no-op, but guard anyway so a
// bad path can never crash the process at import time.
try {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
} catch {
  /* env vars are provided by the platform; ignore .env load failures */
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { sendSms } from "./twilio.js";

// When REMOTE_API_URL is set, all data operations go through the hosted HTTP
// API (so contacts and call records live in one database). Otherwise we use a
// local SQLite database. The concrete backend is chosen at boot in main();
// tool handlers only ever talk to `backend`.
const REMOTE = process.env.REMOTE_API_URL;
let backend;

const server = new McpServer({
  name: "phone-agent",
  version: "1.0.0",
});

// Helpers -------------------------------------------------------------------

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(err) {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${err.message}` }],
  };
}

// Texting requires a real, SMS-capable Twilio number. Until one is configured
// (Twilio needs a paid upgrade), treat send_text as unavailable rather than
// letting it fail deep inside the Twilio API call. SMS is always sent from this
// process (there is no hosted SMS route), even in remote mode.
const TWILIO_NUMBER_PLACEHOLDER = "+15551234567";

function isTextingConfigured() {
  const num = process.env.TWILIO_NUMBER;
  return Boolean(num) && num !== TWILIO_NUMBER_PLACEHOLDER;
}

// Tools ---------------------------------------------------------------------

server.registerTool(
  "add_contact",
  {
    title: "Add Contact",
    description:
      "Add or update a contact. Stores the name and phone number (E.164, e.g. +15551234567).",
    inputSchema: {
      name: z.string().min(1).describe("Contact's name (unique, case-insensitive)."),
      phone: z
        .string()
        .min(1)
        .describe("Phone number in E.164 format, e.g. +15551234567."),
    },
  },
  async ({ name, phone }) => {
    try {
      const contact = await backend.addContact(name, phone);
      return textResult(
        `Saved contact "${contact.name}" with number ${contact.phone}.`
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "send_text",
  {
    title: "Send Text Message",
    description: "Send an SMS to a saved contact via Twilio.",
    inputSchema: {
      name: z.string().min(1).describe("Name of a saved contact."),
      message: z.string().min(1).describe("Text message body to send."),
    },
  },
  async ({ name, message }) => {
    try {
      if (!isTextingConfigured()) {
        return errorResult(
          new Error(
            "Texting is not configured yet. Set a real, SMS-capable TWILIO_NUMBER (in +1XXXXXXXXXX format) in .env to enable send_text. Twilio requires a paid account upgrade for outbound SMS."
          )
        );
      }
      const contact = await backend.getContactByName(name);
      if (!contact) {
        throw new Error(
          `No contact named "${name}". Add one first with add_contact.`
        );
      }
      const result = await sendSms(contact.phone, message);
      return textResult(
        `Text sent to ${contact.name} (${contact.phone}). Twilio SID ${result.sid}, status: ${result.status}.`
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "make_call",
  {
    title: "Make Phone Call",
    description:
      "Place an AI phone call to a saved contact via Vapi. A transient assistant is built from the objective. Voicemail is detected automatically and a short message is left. Returns a call_id to check later with get_call_result.",
    inputSchema: {
      name: z.string().min(1).describe("Name of a saved contact."),
      objective: z
        .string()
        .min(1)
        .describe("Plain-language goal for the call, e.g. 'Book a table for 2 at 7pm'."),
      voicemail_message: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional override for the message left if the call reaches voicemail. If omitted, one is generated from the objective."
        ),
    },
  },
  async ({ name, objective, voicemail_message }) => {
    try {
      const r = await backend.placeCall(name, objective, voicemail_message);
      return textResult(
        `Calling ${r.contact.name} (${r.contact.phone}).\ncall_id: ${r.call_id}\nstatus: ${r.status}\nUse get_call_result with this call_id to fetch the transcript and summary once the call ends.`
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_call_result",
  {
    title: "Get Call Result",
    description:
      "Fetch the status, structured outcome, transcript, and summary of a Vapi call by its call_id.",
    inputSchema: {
      call_id: z.string().min(1).describe("The call_id returned by make_call."),
    },
  },
  async ({ call_id }) => {
    try {
      const { source, call } = await backend.getCallResult(call_id);

      const lines = [
        `Call ${call.call_id}`,
        `Status: ${call.status}${call.ended_reason ? ` (${call.ended_reason})` : ""}`,
      ];
      if (call.batch_id) lines.push(`Batch: ${call.batch_id}`);
      if (call.outcome) lines.push(`Outcome: ${call.outcome}`);
      if (call.callback_time) lines.push(`Callback time: ${call.callback_time}`);
      if (call.notes) lines.push(`Notes: ${call.notes}`);
      if (call.summary) lines.push(`\nSummary:\n${call.summary}`);
      if (call.transcript) lines.push(`\nTranscript:\n${call.transcript}`);
      if (call.recording_url) lines.push(`\nRecording: ${call.recording_url}`);
      if (!call.summary && !call.transcript) {
        lines.push(
          "\n(No transcript or summary yet — the call may still be in progress. Try again shortly.)"
        );
      }
      const sourceLabel =
        source === "webhook"
          ? REMOTE
            ? "hosted webhook cache"
            : "local webhook cache"
          : "Vapi API";
      lines.push(`\n(source: ${sourceLabel})`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "call_list",
  {
    title: "Call a List of Contacts",
    description:
      "Place AI phone calls to several saved contacts with the same objective, staggered a few seconds apart. Voicemail is detected automatically and a short message is left. Returns a batch_id plus a table of contact names and call_ids. Check outcomes later with get_batch_result.",
    inputSchema: {
      names: z
        .array(z.string().min(1))
        .min(1)
        .describe("Names of saved contacts to call."),
      objective: z
        .string()
        .min(1)
        .describe("Plain-language goal used for every call in the batch."),
      voicemail_message: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional override for the message left if a call reaches voicemail. Applies to every call in the batch. If omitted, one is generated from the objective."
        ),
    },
  },
  async ({ names, objective, voicemail_message }) => {
    try {
      const { batch_id, results } = await backend.placeBatch(
        names,
        objective,
        voicemail_message
      );

      const rows = results.map((r) => ({
        name: r.name,
        phone: r.phone || "—",
        call_id: r.call_id || "—",
        status: r.error ? `error: ${r.error}` : r.status,
      }));

      const table = [
        "| Contact | Phone | call_id | Status |",
        "| --- | --- | --- | --- |",
        ...rows.map(
          (r) => `| ${r.name} | ${r.phone} | ${r.call_id} | ${r.status} |`
        ),
      ].join("\n");

      const placed = results.filter((r) => r.call_id).length;
      return textResult(
        `Batch ${batch_id} — placed ${placed}/${names.length} call(s).\n\n${table}\n\nUse get_batch_result with batch_id "${batch_id}" to see each call's outcome once the calls end.`
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_batch_result",
  {
    title: "Get Batch Result",
    description:
      "Fetch the outcome of every call in a batch by its batch_id (returned by call_list).",
    inputSchema: {
      batch_id: z
        .string()
        .min(1)
        .describe("The batch_id returned by call_list."),
    },
  },
  async ({ batch_id }) => {
    try {
      const { calls } = await backend.getBatchResult(batch_id);
      if (!calls || calls.length === 0) {
        return textResult(
          `No calls found for batch "${batch_id}". Double-check the batch_id from call_list.`
        );
      }

      const table = [
        "| Contact | call_id | Status | Outcome | Callback | Notes |",
        "| --- | --- | --- | --- | --- | --- |",
        ...calls.map((c) => {
          const who = c.contact_name || c.customer_number || "Unknown";
          const status = c.ended_reason || c.status || "—";
          const notes = (c.notes || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
          return `| ${who} | ${c.call_id} | ${status} | ${c.outcome || "—"} | ${c.callback_time || "—"} | ${notes || "—"} |`;
        }),
      ].join("\n");

      const withOutcome = calls.filter((c) => c.outcome).length;
      return textResult(
        `Batch ${batch_id} — ${calls.length} call(s), ${withOutcome} with a recorded outcome.\n\n${table}`
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

// Backend selection ---------------------------------------------------------

/**
 * Build the backend used by all tools. Remote mode proxies to the hosted API;
 * local mode uses SQLite + Vapi directly. The local modules are imported
 * lazily so remote mode never opens a local SQLite file.
 */
async function makeBackend() {
  if (REMOTE) {
    const { makeRemoteBackend } = await import("./remote.js");
    console.error(
      `phone-agent MCP server: using hosted API at ${REMOTE.replace(/\/+$/, "")}`
    );
    return makeRemoteBackend();
  }

  const db = await import("./db.js");
  const calls = await import("./calls.js");
  console.error("phone-agent MCP server: using local SQLite.");
  return {
    mode: "local",
    addContact(name, phone) {
      const c = db.addContact(name, phone);
      return { name: c.name, phone: c.phone };
    },
    getContactByName(name) {
      const c = db.getContact(name);
      return c ? { name: c.name, phone: c.phone } : null;
    },
    placeCall(name, objective, vm) {
      return calls.placeCall({ name, objective, voicemailMessage: vm });
    },
    placeBatch(names, objective, vm) {
      return calls.placeBatch({ names, objective, voicemailMessage: vm });
    },
    getCallResult(id) {
      return calls.getCallResult(id);
    },
    async getBatchResult(id) {
      return { batch_id: id, calls: calls.getBatchResult(id) };
    },
  };
}

// Boot ----------------------------------------------------------------------

async function main() {
  backend = await makeBackend();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they don't corrupt the stdio JSON-RPC stream.
  console.error("phone-agent MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error starting phone-agent:", err);
  process.exit(1);
});
