/**
 * NTK-011/017: /ntk-status + /ntk-debug reports, computed from on-disk
 * facts only (.ntk/index.json + plugin log + package.json + debug flag).
 * Shared by the TUI part (dialog/toast rendering) and the server part
 * (file sinks); no server state, no retrieval run. The debug flag
 * (.ntk/debug.json) is read on every server dispatch, so a TUI toggle
 * takes effect live; the per-session "last injection" map is server-only
 * and stays in the server sink (the TUI carries log notice lines).
 */
import fs from "node:fs";
import path from "node:path";
import { isDebugEnabled, setDebugEnabled } from "./debug-logging.js";
import { tailFile } from "./util.js";

export interface IndexSummary {
  version: number;
  builtAt: number;
  docs: number;
  sections: number;
  terms: number;
  indexKB: number;
}

/** Read the persisted index for status facts. Null when missing/corrupt. */
export function readIndexSummary(root: string): IndexSummary | null {
  const p = path.join(root, ".ntk", "index.json");
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      version?: number;
      builtAt?: number;
      stats?: { indexedFiles?: number; sections?: number };
      docs?: unknown[];
      idf?: Record<string, unknown>;
    };
    return {
      version: raw.version ?? 0,
      builtAt: raw.builtAt ?? 0,
      docs: raw.docs?.length ?? raw.stats?.indexedFiles ?? 0,
      sections: raw.stats?.sections ?? Object.keys((raw as { sections?: object }).sections ?? {}).length,
      terms: raw.idf ? Object.keys(raw.idf).length : 0,
      indexKB: Math.round(fs.statSync(p).size / 1024),
    };
  } catch {
    return null;
  }
}

/** Read the last `n` plugin-log lines mentioning `[project]`. */
export function tailProjectLines(logFile: string, project: string, n = 3): string[] {
  const buf = tailFile(logFile);
  const tag = `[${project}] `;
  return buf
    .split("\n")
    .filter((l) => l.includes(tag))
    .map((l) => l.slice(l.indexOf(tag) + tag.length).trim())
    .slice(-n);
}

interface Retrieval {
  kind: "injected" | "reused" | "declined" | "unknown";
  detail: string;
  ms: string;
  rev: string;
}

/** Latest dispatch outcome from the project's log lines (newest last).
 *  "Last retrieval" reports the newest INJECTED dispatch (the last content
 *  actually delivered, with its latency/token facts); a tail of reuse/decline
 *  dispatches without any injection in the window reports reused/declined. */
export function lastRetrieval(lines: string[]): Retrieval | null {
  const dispatches = lines.filter((l) => l.startsWith("dispatch:"));
  const last = [...dispatches].reverse().find((l) => /injected \d+ sections/.test(l));
  const ms = last?.match(/ in (\d+)ms/)?.[1];
  const tok = last?.match(/(\d+)tok content/)?.[1];
  const block = last?.match(/(\d+)tok block/)?.[1];
  const rev = dispatches
    .flatMap((l) => l.match(/hit rev (\d+)/)?.[1] ?? [])
    .pop();
  const kind = last?.includes("injected")
    ? "injected"
    : dispatches.some((l) => /reused \d+ sections|unchanged/.test(l))
      ? "reused"
      : dispatches.some((l) => /DECLINED|declined/.test(l))
        ? "declined"
        : "unknown";
  const detail = last
    ? `injected ${last.match(/injected (\d+) sections/)?.[1] ?? "?"} sections` +
      (tok ? ` (${tok}tok content${block ? ` / ${block}tok block` : ""})` : "")
    : kind === "reused"
      ? "cached delivery (unchanged set)"
      : kind === "declined"
        ? "abstained (gates withheld)"
        : "";
  if (!last && kind === "unknown") return null;
  return { kind, detail, ms: ms ?? "—", rev: rev ?? "—" };
}

function ageLabel(builtAt: number): string {
  const min = Math.round((Date.now() - builtAt) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * The Status report: one line per fact, README "Status" style.
 * `lines` = project log tail (for the last-retrieval section).
 */
export function buildStatusSummary(opts: {
  root: string;
  version: string;
  logFile: string;
}): { report: string; indexMissing: boolean } {
  const project = path.basename(opts.root);
  const idx = readIndexSummary(opts.root);
  const lines = tailProjectLines(opts.logFile, project, 3);
  const out: string[] = [];
  out.push(`NeedToKnow v${opts.version} — project ${project} (plugin v2)`);
  if (idx) {
    out.push(
      // schema version, not the cache revision (a different number entirely)
      `Index: schema v${idx.version} · ${idx.docs} docs · ${idx.sections} sections · ${idx.terms} terms · ${idx.indexKB} KB`,
    );
    out.push(
      `Last reindex: ${idx.builtAt ? new Date(idx.builtAt).toLocaleString() : "—"} (${ageLabel(idx.builtAt)})`,
    );
  } else {
    out.push("Index: MISSING — run /ntk-reindex (skill ntk-reindex) to build it.");
  }
  const r = lastRetrieval(lines);
  out.push(
    r
      ? `Last retrieval: ${r.kind} — ${r.detail} · ${r.ms}ms · cache rev ${r.rev}`
      : "Last retrieval: no dispatches logged for this project",
  );
  if (lines.length) {
    out.push(`Recent log (${opts.logFile}):`);
    for (const l of lines) out.push(`  · ${l.slice(0, 160)}${l.length > 160 ? "…" : ""}`);
  }
  out.push("Full report: .ntk/status.md · audit: .ntk/debug.jsonl (NTK-DEBUG)");
  return { report: out.join("\n"), indexMissing: !idx };
}

/** Version from the plugin package.json, resolved relative to this module
 *  (works in src/ via tsx and in dist/ after build). */
export function pluginVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The /ntk-debug ON help text — one copy for the server sink and the TUI
 *  dialog (mirrors the .ntk/status.md layout). */
export const DEBUG_ON_HELP =
  "NTK-DEBUG: ON. Debug output is FILE-ONLY (nothing in chat, nothing in the model view):\n" +
  "  .ntk/debug.jsonl — one JSON audit record per model dispatch: cache kind + invalidation\n" +
  "    cause + revision; blended query (current turn, task anchor, activity files) + raw/expanded\n" +
  "    terms; thresholds; ranked candidates (file#section, source lines, final + BM25-base score,\n" +
  "    matched terms); injected passages (file, section, lines, level, tokens, scores, matched\n" +
  "    terms, compression ratio, doc mtime) and the reason; rejection evidence (gate, redundancy,\n" +
  "    structure-only, relative-floor, cap/budget truncation); hysteresis retentions; reuse\n" +
  "    records; per-stage latency.\n" +
  "  plugin log — operational lines + one `NTK-DEBUG: INJECTED|REUSED|DECLINED …` summary\n" +
  "    per user turn.\n" +
  "  .ntk/status.md — command reports.\n" +
  "INJECTED = newly selected/changed; REUSED = cached delivery (not a failure); DECLINED =\n" +
  "gates withheld, with the exact reason. Records carry section names and numbers only —\n" +
  "never document content.";

/**
 * /ntk-debug report for arg = "on" | "off" | "status". Toggles the
 * file-backed flag (server picks it up on its next dispatch — the
 * per-session "Docs of the last injection" map is server-only and is
 * appended by the server sink; the TUI report carries the log summary
 * lines instead).
 */
export function buildDebugReport(
  root: string,
  arg: string,
  logFile: string,
  version: string,
): string {
  const project = path.basename(root);
  const notices = () =>
    tailProjectLines(logFile, project, 40).filter((l) => l.includes("NTK-DEBUG:"));
  if (arg === "on") {
    setDebugEnabled(root, true);
    const seen = notices();
    return (
      DEBUG_ON_HELP +
      (seen.length
        ? `\nLast debug notices (${logFile}):\n` +
          seen.slice(-3).map((l) => `  · ${l.slice(0, 160)}${l.length > 160 ? "…" : ""}`).join("\n")
        : "\nNo NTK-DEBUG summary lines in the log yet — the next user turn produces one.")
    );
  }
  if (arg === "off") {
    setDebugEnabled(root, false);
    return "NTK-DEBUG: OFF.";
  }
  const on = isDebugEnabled(root);
  if (!on) return "NTK-DEBUG: OFF.";
  const seen = notices();
  return (
    `NTK-DEBUG: ON (plugin v${version}, project ${project}).` +
    (seen.length
      ? `\nLast debug notices (${logFile}):\n` +
        seen.slice(-3).map((l) => `  · ${l.slice(0, 160)}${l.length > 160 ? "…" : ""}`).join("\n")
      : "\nNo NTK-DEBUG summary lines in the log yet.")
  );
}
