/** Tool-event tracking (audit P1-10, NTK-004/NTK-010 self-index).
 *
 * Pure helpers that map OpenCode V2 tool events onto the two signals NTK
 * needs: (a) file activity for retrieval, (b) doc edits for reindex. Tool
 * names and argument shapes drift across releases — every assumption lives
 * here, behind unit tests (test/tool-events.test.ts), instead of inline in
 * the plugin hook.
 */

/** Write-capable tools (V2 names; multiedit/patch kept as aliases). */
export const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit", "patch"]);
/** Read-capable tools whose targets are activity signals. */
export const READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);

/** Extract the file/dir path from a tool's args across known shapes. */
export function extractFilePath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ["filePath", "path", "file", "target"] as const) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  // apply_patch: no direct path arg (paths are inside the patch text) —
  // activity tracking skips; the tool-result output names touched files.
  return null;
}

const SUCCESS_RE = /succe|wrote|created|edited|patched|applied|replacement|replac/;
const FAILURE_RE = /"error"\s*:|^\s*\{"error"|no such file|permission denied|failed/;

/** True when a completed write tool call plausibly modified the file.
 *  Audit P1-10: the old regex required capital "Successfully"; real V2
 *  results say "Created file successfully", "Edited … (1 replacement)" —
 *  lowercase, so self-reindex silently never fired for many edits. Match
 *  is case-insensitive, and an explicit error payload never counts. */
export function looksLikeSuccessfulWrite(
  tool: string,
  status: string,
  resultText: string,
): boolean {
  if (!WRITE_TOOLS.has(tool)) return false;
  if (status === "error") return false;
  const t = resultText.toLowerCase();
  if (FAILURE_RE.test(t)) return false;
  return SUCCESS_RE.test(t);
}

/** Flatten a tool result payload (string | content parts) to text. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : ""))
      .join("\n");
  return "";
}
