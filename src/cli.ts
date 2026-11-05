#!/usr/bin/env node
/** NTK developer/eval CLI (design.md §8). Not required at runtime.
 *  Usage: npx tsx src/cli.ts <index|query|status|bench> <root> [args]
 */
import { indexProjectFull, loadIndex } from "./index-store.js";
import { runRetrieval, DEFAULTS } from "./core/retrieval.js";
import type { ContextItem } from "./core/types.js";
import fs from "node:fs";
import path from "node:path";

const [, , cmd, ...rest] = process.argv;
const root = path.resolve(rest[0] ?? ".");
const args = rest.slice(1);

function flag(name: string): string | undefined {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
}

function ntkIndexPath(r: string): string {
  return path.join(r, ".ntk", "index.json");
}

function mustLoad(): ReturnType<typeof loadIndex> {
  const idx = loadIndex(root);
  if (!idx) {
    console.error(`[ntk] no index for ${root} — run: npx tsx src/cli.ts index ${root}`);
    process.exit(1);
  }
  return idx;
}

const EMPTY_SET = new Set<string>();

function render(items: ContextItem[]): string {
  if (!items.length) return "";
  const lines = ["<needtoknow_context>"]; // canonical tag (P0-6): one everywhere
  for (const it of items) {
    lines.push(`## ${it.docPath}${it.heading ? ` › ${it.heading}` : ""} [${it.level}]`);
    lines.push(it.content);
    lines.push("");
  }
  lines.push("</needtoknow_context>");
  return lines.join("\n");
}

switch (cmd) {
  case "index": {
    const t0 = performance.now();
    // --force: skip the fingerprint probe and rebuild from scratch (mirrors
    // the ntk_index tool's force; also drops any stale cache via full write).
    const { stats } = indexProjectFull(root, { force: args.includes("--force") });
    const p = ntkIndexPath(root);
    console.log(
      JSON.stringify(
        {
          project: root,
          indexedFiles: stats.indexedFiles,
          files: stats.files,
          skipped: stats.skipped,
          sections: stats.sections,
          indexMs: Math.round(stats.indexMs),
          totalMs: Math.round(performance.now() - t0),
          indexFile: p,
          indexKB: fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) : 0,
        },
        null,
        2,
      ),
    );
    break;
  }
  case "query": {
    const q = args[0];
    if (!q) throw new Error("usage: query <root> <text> [--json] [--verbose]");
    const idx = mustLoad()!;
    const t0 = performance.now();
    const res = runRetrieval(idx, q, EMPTY_SET);
    const totalMs = performance.now() - t0;
    const tokens = res.items.reduce((s, i) => s + i.tokens, 0);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ items: res.items, trace: res.trace, totalMs }, null, 2));
    } else {
      if (res.items.length) console.log(render(res.items));
      console.log(
        `\n[ntk] fired=${res.items.length > 0} items=${res.items.length} ` +
          `tokens=${tokens} ms=${totalMs.toFixed(1)}` +
          (res.trace.gateReason ? ` gate: ${res.trace.gateReason}` : ""),
      );
      if (args.includes("--verbose")) {
        console.log("[ntk] query terms:", res.trace.terms.join(" "));
        console.log("[ntk] expanded:   ", res.trace.expanded);
        for (const id of res.trace.candidates) {
          const hit = idx.sections.get(id);
          console.log(
            `  • ${id} ${hit ? `[${hit.tokens}tok]` : ""}`,
          );
        }
        for (const it of res.items)
          console.log(
            `  → ${it.docPath} › ${it.heading} [${it.level}] score=${it.score.toFixed(1)} ` +
              `tokens=${it.tokens} comp=${it.compression ? it.compression.kept + "/" + it.compression.total : "-"}`,
          );
      }
    }
    break;
  }
  case "status": {
    const tLoad0 = performance.now();
    const idx = mustLoad()!;
    const indexLoadMs = Math.round(performance.now() - tLoad0);
    const p = ntkIndexPath(root);
    const probe = flag("probe") ?? "";
    let probeInfo: unknown = undefined;
    if (probe) {
      const res = runRetrieval(idx, probe, EMPTY_SET, {}, 30);
      probeInfo = {
        query: probe,
        fired: res.items.length > 0,
        gateReason: res.trace.gateReason || null,
        queryTerms: res.trace.queryTerms,
        expandedTerms: res.trace.expandedTerms,
        candidates: res.trace.candidates,
        items: res.items.map((it) => ({
          docPath: it.docPath,
          heading: it.heading,
          level: it.level,
          score: +it.score.toFixed(1),
          tokens: it.tokens,
          compression: it.compression
            ? `${it.compression.kept}/${it.compression.total}`
            : null,
        })),
        latencyMs: res.trace.latencyMs,
      };
    }
    console.log(
      JSON.stringify(
        {
          project: root,
          indexedFiles: idx.stats.indexedFiles,
          files: idx.stats.files,
          sections: idx.sectionList.length,
          skipped: idx.stats.skipped,
          builtAt: idx.builtAt,
          indexKB: fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) : 0,
          indexLoadMs,
          tokenBudget: DEFAULTS.tokenBudget,
          probe: probeInfo,
        },
        null,
        2,
      ),
    );
    break;
  }
  case "bench": {
    const file = args[0];
    if (!file) throw new Error("usage: bench <root> <queries.json>");
    const queries = JSON.parse(fs.readFileSync(file, "utf8")) as { query: string }[];
    const idx = mustLoad()!;
    const times: number[] = [];
    let firedCount = 0;
    let tokenTotal = 0;
    for (const q of queries) {
      const t0 = performance.now();
      const r = runRetrieval(idx, q.query, EMPTY_SET);
      times.push(performance.now() - t0);
      if (r.items.length > 0) firedCount++;
      tokenTotal += r.items.reduce((s, i) => s + i.tokens, 0);
    }
    times.sort((a, b) => a - b);
    // Nearest-rank percentile (ceil(p·n)−1): the previous floor() skewed the
    // 95th of 100 samples to index 95 (the 96th), diverging from the plugin's
    // debugStats formula for the same metric.
    const pct = (p: number) =>
      times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)]! : 0;
    console.log(
      JSON.stringify(
        {
          queries: queries.length,
          fired: firedCount,
          P50ms: +pct(0.5).toFixed(1),
          P95ms: +pct(0.95).toFixed(1),
          maxms: +times[times.length - 1]!.toFixed(1),
          avgTokensPerFiredQuery: firedCount ? Math.round(tokenTotal / firedCount) : 0,
        },
        null,
        2,
      ),
    );
    break;
  }
  case "smoke": {
    // Self-test on the pilot corpus: exercises the fallback path (empty query terms).
    const idx = mustLoad()!;
    const samples = ["登录", "login flow", "deployment guide", "数据库配置", "zzzz"];
    for (const s of samples) {
      const res = runRetrieval(idx, s, EMPTY_SET);
      console.log(
        `[smoke] "${s}" → fired=${res.items.length > 0} items=${res.items.length} ` +
          `qt=${res.trace.queryTerms.length} cand=${res.trace.candidates.length} ` +
          `gate=${res.trace.gateReason || "-"} ms=${res.trace.latencyMs}`,
      );
      if (res.items[0])
        console.log(
          `        top: ${res.items[0].docPath} [${res.items[0].level}] tok=${res.items[0].tokens}`,
        );
    }
    break;
  }
  default:
    console.error(
      "commands: index <root> | query <root> <text> [--json|--verbose] | status <root> [--probe <text>] | bench <root> <queries.json> | smoke <root>",
    );
    process.exit(1);
}
