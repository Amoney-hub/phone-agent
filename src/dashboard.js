import fs from "node:fs";
import path from "node:path";

const htmlPath = path.join(import.meta.dirname, "dashboard.html");
const loginPath = path.join(import.meta.dirname, "login.html");

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
