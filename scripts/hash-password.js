#!/usr/bin/env node
// Generate a bcrypt hash for the dashboard admin password.
//
// Usage:
//   node scripts/hash-password.js 'my-password'      # password as an argument
//   node scripts/hash-password.js                    # read from stdin (no shell history)
//
// Copy the printed line into your .env as DASHBOARD_PASSWORD_HASH.

import readline from "node:readline";
import bcrypt from "bcryptjs";

const COST = 12;

function fromStdin() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let line = "";
    rl.on("line", (l) => {
      line = l;
      rl.close();
    });
    rl.on("close", () => resolve(line));
  });
}

async function main() {
  let password = process.argv[2];
  if (!password) {
    if (process.stdin.isTTY) {
      process.stderr.write("Enter password (will be echoed): ");
    }
    password = (await fromStdin()).trim();
  }
  if (!password) {
    console.error("Error: empty password. Provide one as an argument or via stdin.");
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, COST);
  // Print just the hash on stdout so it can be piped/copied cleanly.
  console.log(hash);
  console.error(
    "\nAdd this to your .env (quote it — the hash contains $):\n" +
      `DASHBOARD_PASSWORD_HASH='${hash}'`
  );
}

main().catch((err) => {
  console.error("Failed to hash password:", err);
  process.exit(1);
});
