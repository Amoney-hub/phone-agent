#!/usr/bin/env node
import path from "node:path";
import dotenv from "dotenv";

// Resolve .env relative to this source file, not the process cwd — Claude
// Desktop launches the server from a different working directory.
dotenv.config({ path: path.join(import.meta.dirname, "..", ".env") });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import crypto from "node:crypto";

import {
  addContact,
  getContact,
  getStoredCall,
  recordPlacedCall,
  getBatchCalls,
} from "./db.js";
import { sendSms } from "./twilio.js";
import { createCall, getCall } from "./vapi.js";

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
// letting it fail deep inside the Twilio API call.
const TWILIO_NUMBER_PLACEHOLDER = "+15551234567";

function isTextingConfigured() {
  const num = process.env.TWILIO_NUMBER;
  return Boolean(num) && num !== TWILIO_NUMBER_PLACEHOLDER;
}

function resolveContact(name) {
  const contact = getContact(name);
  if (!contact) {
    throw new Error(
      `No contact named "${name}". Add one first with add_contact.`
    );
  }
  return contact;
}

// Tools ---------------------------------------------------------------------

server.registerTool(
  "add_contact",
  {
    title: "Add Contact",
    description:
      "Add or update a contact. Stores the name and phone number (E.164, e.g. +15551234567) in SQLite.",
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
      const contact = addContact(name, phone);
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
      const contact = resolveContact(name);
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
      const contact = resolveContact(name);
      const call = await createCall(contact.phone, objective, {
        voicemailMessage: voicemail_message,
      });
      // Record it locally so it shows up right away (batch_id stays null).
      recordPlacedCall({
        callId: call.id,
        customerNumber: contact.phone,
        status: call.status ?? "queued",
      });
      return textResult(
        `Calling ${contact.name} (${contact.phone}).\ncall_id: ${call.id}\nstatus: ${call.status ?? "queued"}\nUse get_call_result with this call_id to fetch the transcript and summary once the call ends.`
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
      "Fetch the status, transcript, and summary of a Vapi call by its call_id.",
    inputSchema: {
      call_id: z.string().min(1).describe("The call_id returned by make_call."),
    },
  },
  async ({ call_id }) => {
    try {
      // Prefer the locally stored webhook report (instant, no network).
      const stored = getStoredCall(call_id);
      let call;
      let source;
      if (stored) {
        call = {
          id: stored.call_id,
          status: stored.status,
          endedReason: stored.ended_reason,
          summary: stored.summary,
          transcript: stored.transcript,
          recordingUrl: stored.recording_url,
          outcome: stored.outcome,
          callbackTime: stored.callback_time,
          notes: stored.notes,
          batchId: stored.batch_id,
        };
        source = "webhook";
      } else {
        // Not received via webhook yet — fall back to the Vapi API.
        call = await getCall(call_id);
        source = "api";
      }

      const lines = [
        `Call ${call.id}`,
        `Status: ${call.status}${call.endedReason ? ` (${call.endedReason})` : ""}`,
      ];
      if (call.batchId) lines.push(`Batch: ${call.batchId}`);
      if (call.outcome) lines.push(`Outcome: ${call.outcome}`);
      if (call.callbackTime) lines.push(`Callback time: ${call.callbackTime}`);
      if (call.notes) lines.push(`Notes: ${call.notes}`);
      if (call.summary) lines.push(`\nSummary:\n${call.summary}`);
      if (call.transcript) lines.push(`\nTranscript:\n${call.transcript}`);
      if (call.recordingUrl) lines.push(`\nRecording: ${call.recordingUrl}`);
      if (!call.summary && !call.transcript) {
        lines.push(
          "\n(No transcript or summary yet — the call may still be in progress. Try again shortly.)"
        );
      }
      lines.push(
        `\n(source: ${source === "webhook" ? "local webhook cache" : "Vapi API"})`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Seconds between successive dials in a batch, to avoid hammering the provider
// and to space out simultaneous ringing.
const BATCH_STAGGER_MS = 3000;

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
      const batchId = `batch_${crypto.randomUUID()}`;
      const rows = [];

      for (let i = 0; i < names.length; i++) {
        if (i > 0) await sleep(BATCH_STAGGER_MS);
        const name = names[i];
        try {
          const contact = resolveContact(name);
          const call = await createCall(contact.phone, objective, {
            voicemailMessage: voicemail_message,
          });
          recordPlacedCall({
            callId: call.id,
            batchId,
            customerNumber: contact.phone,
            status: call.status ?? "queued",
          });
          rows.push({
            name: contact.name,
            phone: contact.phone,
            call_id: call.id,
            status: call.status ?? "queued",
          });
        } catch (err) {
          rows.push({ name, phone: "—", call_id: "—", status: `error: ${err.message}` });
        }
      }

      const table = [
        "| Contact | Phone | call_id | Status |",
        "| --- | --- | --- | --- |",
        ...rows.map(
          (r) => `| ${r.name} | ${r.phone} | ${r.call_id} | ${r.status} |`
        ),
      ].join("\n");

      const placed = rows.filter((r) => r.call_id !== "—").length;
      return textResult(
        `Batch ${batchId} — placed ${placed}/${names.length} call(s).\n\n${table}\n\nUse get_batch_result with batch_id "${batchId}" to see each call's outcome once the calls end.`
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
      const calls = getBatchCalls(batch_id);
      if (calls.length === 0) {
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

// Boot ----------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they don't corrupt the stdio JSON-RPC stream.
  console.error("phone-agent MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error starting phone-agent:", err);
  process.exit(1);
});
