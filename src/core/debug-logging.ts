/** NTK-017: per-dispatch decision audit, turn notices, and the file log
 *  channel — restored (Nov 3) from the proto-bench reference + live
 *  JetBrains-written record schema (design.md §9.2, SPEC NTK-017).
 *  FILE-ONLY (NTK-011 data dir): .ntk/debug.json flag, .ntk/debug.jsonl
 *  audit (one JSON record per model dispatch), .ntk/status.md reports.
 *  Records carry section names and numbers only — NEVER document content.
 *  Off by default; every entry point is inert when off. */
import fs from "node:fs";
import path from "node:path";
import type { ContextItem, RetrievalTrace } from "./types.js";

export const DEBUG_PREFIX = "NTK-DEBUG:";
export const DEBUG_TAG = "needtoknow/debug";
const MAX_DEBUG_BYTES = 8 * 1024 * 1024;

export type DebugOutcome = "INJECTED" | "REUSED" | "DECLINED";

const flagPath = (root: string) => path.join(root, ".ntk", "debug.json");

/** EXP-R: the flag is read on EVERY audit entry point (several times per
 *  dispatch). A 1s TTL keeps the documented live-toggle semantics (a TUI
 *  toggle reaches the server within a second) without the hot-path disk
 *  read. Negative results cached too — absent flag = debug off. */
const FLAG_TTL_MS = 1000;
const flagCache = new Map<string, { at: number; on: boolean }>();

export function isDebugEnabled(root: string): boolean {
  const now = Date.now();
  const hit = flagCache.get(root);
  if (hit && now - hit.at < FLAG_TTL_MS) return hit.on;
  let on = false;
  try {
    const j = JSON.parse(fs.readFileSync(flagPath(root), "utf8")) as { debug?: boolean };
    on = j.debug === true;
  } catch {
    on = false;
  }
  flagCache.set(root, { at: now, on });
  return on;
}

export function setDebugEnabled(root: string, on: boolean): void {
  try {
    fs.mkdirSync(path.join(root, ".ntk"), { recursive: true });
    fs.writeFileSync(flagPath(root), JSON.stringify({ debug: on }));
  } catch {
    /* diagnostics must never break the host */
  }
  flagCache.set(root, { at: Date.now(), on }); // toggle is visible immediately
  if (!on) {
    debugTurn.clear();
    lastGateReason.clear();
  }
}

/** Drop a deleted session's per-session diagnostic state (plugin cleanup). */
export function clearSessionDiagnostics(sessionID: string): void {
  debugTurn.delete(sessionID);
  lastGateReason.delete(sessionID);
}

/** True for content NTK itself posted on the debug channel: tagged part,
 *  tagged message, the synthetic message role, or text STARTING with the
 *  debug prefix. Deliberately narrow: a genuine user message that merely
 *  quotes "NTK-DEBUG" is user content and is never stripped. */
export function isDebugContent(
  m: { role?: string; metadata?: Record<string, unknown>; content?: unknown },
  part?: { text?: string; metadata?: Record<string, unknown> },
): boolean {
  if (m.metadata?.["tag"] === DEBUG_TAG) return true;
  if (m.role === "synthetic") return true;
  if (part) {
    if (part.metadata?.["tag"] === DEBUG_TAG) return true;
    return (part.text ?? "").startsWith(DEBUG_PREFIX);
  }
  return (
    (m.content as Array<{ type: string; text?: string; metadata?: Record<string, unknown> }> | undefined)
      ?.some((p) => p.type === "text" && isDebugContent(m, p)) ?? false
  );
}

/** Append one audit record (debug-gated, content-free, 8 MB rollover). */
export function audit(
  root: string,
  ctx: { sessionID: string; turnKey: string },
  rec: Record<string, unknown>,
): void {
  if (!isDebugEnabled(root)) return;
  const line = JSON.stringify({
    ev: "dispatch",
    ts: new Date().toISOString(),
    session: ctx.sessionID.slice(-8),
    turnKey: ctx.turnKey,
    ...rec,
  });
  try {
    const f = path.join(root, ".ntk", "debug.jsonl");
    fs.mkdirSync(path.join(root, ".ntk"), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > MAX_DEBUG_BYTES) fs.renameSync(f, f + ".1");
    fs.appendFileSync(f, line + "\n");
  } catch {
    /* file diagnostics are best-effort */
  }
}

/** Full per-dispatch audit built from the retrieval trace (names+numbers only). */
export function auditDispatch(
  root: string,
  ctx: {
    sessionID: string;
    turnKey: string;
    cache?: { kind?: string; invalidation?: string | null; revision?: number };
    query?: { current: string; anchor: string; activity: string[]; terms: string[]; expanded: string[] };
  },
  o: {
    outcome: DebugOutcome;
    via: string;
    reason: string;
    trace?: RetrievalTrace;
    items?: ContextItem[];
    cachedIds?: string[];
    tokens?: number | null;
    /** EXP-R D12: cache-path dispatches record the check cost (were null). */
    latencyMs?: number;
  },
): void {
  if (!isDebugEnabled(root)) return;
  const t = o.trace;
  audit(root, ctx, {
    outcome: o.outcome,
    via: o.via,
    reason: o.reason,
    cache: ctx.cache ?? null,
    query: ctx.query
      ? {
          ...ctx.query,
          // EXP-R D12: persistence caps sized for faithful replay — the old
          // 2000/500 truncation broke A-replay fidelity (Q40 gate: 33%).
          current: ctx.query.current.slice(0, 8000),
          anchor: ctx.query.anchor.slice(0, 3000),
        }
      : null,
    thresholds: t?.thresholds ?? null,
    latencyMs: t?.latencyMs ?? o.latencyMs ?? null,
    stages: t?.stages ?? null,
    budget: t ? { allocated: t.allocatedBudget ?? null, sources: t.allocatedSources ?? null } : null,
    gate: t
      ? {
          passed: t.passedGate,
          reason: t.gateReason,
          coverage: (t as { gateCoverage?: number }).gateCoverage ?? null,
          rarest: (t as { gateRarest?: number }).gateRarest ?? null,
          span: (t as { gateSpan?: number }).gateSpan ?? null,
          override: t.gateOverride ?? null,
        }
      : null,
    hysteresis: t ? { retained: t.retained ?? [] } : null,
    spread: t ? { added: t.spreadAdded ?? 0, evidence: t.spreadEvidence ?? [] } : null,
    rejected: t
      ? {
          redundant: t.excludedRedundant ?? [],
          empty: t.excludedEmpty ?? [],
          relative: t.excludedRelative ?? [],
          truncated: t.truncated ?? [],
        }
      : null,
    candidates: t
      ? t.scored.slice(0, 12).map((e) => ({
          id: e.id,
          lines: [e.startLine, e.endLine],
          score: e.score,
          base: e.base,
          matched: e.matched,
          exactTitle: e.exactTitle,
        }))
      : undefined,
    items: o.items
      ? o.items.map((i) => ({
          doc: i.docPath,
          section: i.sectionPath || i.heading || "top",
          lines: [i.startLine, i.endLine],
          level: i.level,
          tokens: i.tokens,
          score: i.score,
          base: (i as { base?: number }).base ?? null,
          matched: (i as { matchedTerms?: string[] }).matchedTerms ?? [],
          compression: i.compression ? `${i.compression.kept}/${i.compression.total}` : null,
          mtime: (i as { docMtime?: number }).docMtime ?? null,
        }))
      : undefined,
    cachedIds: o.cachedIds,
    tokens: o.tokens ?? null,
  });
}

/* ------------------------------------------------------- turn notices -- */

/** NTK-017: one accumulator per user turn; every model dispatch of the turn
 *  records into it; the flush emits ONE summary (log channel). */
export interface TurnDebug {
  turnKey: string;
  outcome: DebugOutcome;
  sections: string;
  tokens: number | null;
  reason: string;
  note: string;
  counts: Record<DebugOutcome, number>;
  dispatches: number;
  recalcs: number;
}
export const debugTurn = new Map<string, TurnDebug>();
/** Last real gate verdict per session, quoted inside verified-empty notices. */
export const lastGateReason = new Map<string, string>();

/** Section list for freshly selected items (names + tokens, never content). */
export function sectionsList(items: ContextItem[]): string {
  const toks = items.reduce((s, i) => s + i.tokens, 0);
  const secs = items
    .map((i) => `${i.docPath}#${i.sectionPath || i.heading || "top"} (${i.level})`)
    .join(", ");
  return `${items.length} section(s), ~${toks}tok: ${secs}`;
}

/** Section list for a cache-served dispatch, parsed back from the stored block. */
export function sectionsFromBlock(block: string): string {
  const sources = [...block.matchAll(/^Source: (.+?) \((\w+)/gm)];
  const secs = sources.map((m) => `${m[1]} (${m[2]})`).join(", ");
  return `${sources.length} section(s), ~${Math.round(block.length / 3)}tok: ${secs}`;
}

/** Record this dispatch's outcome into the current user turn. Called from the
 *  actual injection path — reports what really went to the model. */
export function recordDebugOutcome(
  root: string,
  sessionID: string,
  turnKey: string,
  o: {
    outcome: DebugOutcome;
    sections?: string;
    tokens?: number | null;
    reason?: string;
    note?: string;
    recalculated: boolean;
  },
): void {
  if (!isDebugEnabled(root)) return;
  let t = debugTurn.get(sessionID);
  if (!t || t.turnKey !== turnKey) {
    t = {
      turnKey,
      outcome: o.outcome,
      sections: "",
      tokens: null,
      reason: "",
      note: "",
      counts: { INJECTED: 0, REUSED: 0, DECLINED: 0 },
      dispatches: 0,
      recalcs: 0,
    };
    debugTurn.set(sessionID, t);
  }
  t.counts[o.outcome] += 1;
  t.dispatches += 1;
  if (o.recalculated) t.recalcs += 1;
  t.outcome = o.outcome;
  if (o.sections !== undefined) t.sections = o.sections;
  if (o.tokens !== undefined) t.tokens = o.tokens;
  if (o.reason !== undefined) t.reason = o.reason;
  if (o.note !== undefined) t.note = o.note;
}

/** Render the turn's single notice: final outcome + per-dispatch summary. */
export function renderDebugNotice(t: TurnDebug): string {
  const summary =
    `${t.dispatches} dispatch${t.dispatches === 1 ? "" : "es"}: ` +
    (["INJECTED", "REUSED", "DECLINED"] as const)
      .filter((k) => t.counts[k] > 0)
      .map((k) => `${k} ${t.counts[k]}`)
      .join(", ") +
    `; retrieval recalculated ${t.recalcs}×`;
  const note = t.note ? ` — ${t.note}` : "";
  switch (t.outcome) {
    case "INJECTED":
      return `${DEBUG_PREFIX} INJECTED${note}: ${t.sections} (${summary})`;
    case "REUSED":
      return (
        `${DEBUG_PREFIX} REUSED${note} (cache delivery, not an injection failure): ` +
        `${t.sections} (${summary})`
      );
    case "DECLINED":
      return `${DEBUG_PREFIX} DECLINED — ${t.reason || "no qualifying documentation"} (${summary})`;
  }
}

/** Flush the session's pending turn notice to the log channel (one line). */
export function flushDebugNotice(sessionID: string, log: (msg: string) => void): void {
  const t = debugTurn.get(sessionID);
  if (!t) return;
  debugTurn.delete(sessionID);
  log(renderDebugNotice(t));
}

/** Local diagnostic sink for command reports (/ntk-status, /ntk-debug).
 *  FILE-ONLY: plugin log first line + .ntk/status.md; chat and the model
 *  view carry no diagnostics; NEVER a model-bound prompt. */
export function localReport(root: string, report: string, log: (msg: string) => void): void {
  // EXP-R D13: hardened reporting — the file is the durable channel; if the
  // log callback yields nothing (IDE command output path) the file write
  // still lands, and a file failure surfaces the report to the log.
  try {
    log(report.split("\n")[0]!);
  } catch { /* host log unavailable */ }
  try {
    fs.mkdirSync(path.join(root, ".ntk"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ntk", "status.md"), `${report}\n`);
  } catch {
    try {
      log(report); // last resort: full report to the log channel
    } catch { /* diagnostics must never break the host */ }
  }
}

/** Docs of the session's most recent injection, parsed from the stored block. */
export function lastInjectedDocs(block: string | undefined): string {
  if (!block) return "  (no injection in this session yet)";
  const docs = block
    .split("\n")
    .filter((l) => l.startsWith("Source: "))
    .map((l) => "  " + l.replace(/^Source: /, ""));
  return docs.length ? docs.join("\n") : "  (no injection in this session yet)";
}
