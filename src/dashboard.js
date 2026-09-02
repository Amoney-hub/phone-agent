import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dirname` is only on Node 20.11+; fall back so these resolve on
// older/hosted runtimes instead of yielding an undefined path.
const __dirname =
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

const htmlPath = path.join(__dirname, "dashboard.html");
const loginPath = path.join(__dirname, "login.html");
const clientPath = path.join(__dirname, "client.html");
const developersPath = path.join(__dirname, "developers.html");

/**
 * Return the self-contained dashboard HTML. Read from disk each call so edits
 * show up on refresh without restarting the server.
 */
export function renderDashboard() {
  return fs.readFileSync(htmlPath, "utf8");
}

/** Return the self-contained login page HTML. */
export function renderLogin() {
  return fs.readFileSync(loginPath, "utf8");
}

/** Return the self-contained client (read-only) results page HTML. */
export function renderClient() {
  return fs.readFileSync(clientPath, "utf8");
}

/** Return the public "coming soon" developers landing page HTML. */
export function renderDevelopers() {
  return fs.readFileSync(developersPath, "utf8");
}
