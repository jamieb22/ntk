/** Shared file logger for the server and TUI plugin parts (one home for the
 *  appendFileSync channel; logging must never break the host). */
import fs from "node:fs";

export const LOG_FILE = process.env["NTK_LOG"] ?? "/tmp/ntk-plugin.log";

export function log(msg: string): void {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never break the host */
  }
}
