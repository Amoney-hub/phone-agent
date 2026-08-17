#!/usr/bin/env node
// Create a client tenant, optionally with a login and per-outcome values.
//
// Usage:
//   node scripts/add-client.js "Acme Plumbing"
//   node scripts/add-client.js "Acme Plumbing" acme s3cret
//   node scripts/add-client.js "Acme Plumbing" acme s3cret '{"booked":200,"interested":40}'
//
// (You can also do all of this from the admin dashboard's "Client settings".)

import bcrypt from "bcryptjs";
import { createClient, setClientLogin, setClientOutcomeValues } from "../src/db.js";

const [, , name, username, password, valuesJson] = process.argv;

if (!name) {
  console.error('Usage: node scripts/add-client.js "Client Name" [username] [password] [valuesJson]');
  process.exit(1);
}

let outcomeValues = {};
if (valuesJson) {
  try {
    outcomeValues = JSON.parse(valuesJson);
  } catch {
    console.error(`Could not parse values JSON: ${valuesJson}`);
    process.exit(1);
  }
}

const client = createClient({ name, outcomeValues });
if (username && password) {
  setClientLogin(client.id, username, bcrypt.hashSync(String(password), 12));
} else if (username || password) {
  console.error("Provide BOTH username and password to set a login (or neither).");
  process.exit(1);
}
if (valuesJson) setClientOutcomeValues(client.id, outcomeValues);

console.log(
  `Created client #${client.id} "${client.name}"` +
    (username ? ` with login "${username}"` : " (no login yet)") +
    (valuesJson ? ` and values ${JSON.stringify(outcomeValues)}` : "")
);
