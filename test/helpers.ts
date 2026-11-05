/** Shared test fixtures: standard corpus + temp-project factory.
 *
 * The corpus is deliberately partitioned: each doc owns a distinct vocabulary,
 * so BM25 hits, per-doc caps, and budget behavior are predictable.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stem, isStopword } from "../src/core/tokenize.js";
import type { Block, SectionRecord } from "../src/core/types.js";

export function stemWords(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().split(/[^a-z0-9_\.\-]+/)) {
    if (w.length < 2) continue;
    const s = stem(w);
    if (s && !isStopword(s)) out.push(s);
  }
  return out;
}

/** Build a canonical SectionRecord from plain sentence strings (or Blocks). */
export function makeSection(
  id: string,
  docPath: string,
  title: string,
  content: Array<string | Block>,
  ordinal = 0,
): SectionRecord {
  const blocks: Block[] = content.map((c) =>
    typeof c === "string" ? { kind: "sentence" as const, text: c } : c,
  );
  const text = blocks.map((b) => b.text).join(" ");
  const headings = title.split(" > ").map((h) => h.trim());
  const heading = headings[headings.length - 1] ?? title;
  const terms = stemWords(text);
  const headingStems = stemWords(headings.join(" "));
  return {
    id,
    docPath,
    docTitle: title,
    heading,
    headings,
    level: headings.length,
    sectionPath: headings.join(" > "),
    startLine: 1,
    ordinal,
    docSections: 1,
    text,
    blocks,
    terms,
    fields: {
      title: headingStems,
      headings: headingStems,
      terms,
      body: terms,
    },
    tokens: Math.max(1, Math.ceil(text.length / 4)),
  };
}

/** Returns [term, count] pairs expanded into a sentence. */
function sent(...parts: Array<string | [string, number]>): string {
  return parts
    .map((p) => {
      if (Array.isArray(p)) return Array.from({ length: p[1] }, () => p[0]).join(" ");
      return p;
    })
    .join(" ")
    .trim();
}

export type Corpus = Record<string, string | null>;

/**
 * Six markdown docs with disjoint vocabularies + one oversized file (null =
 * 600 KB generated, over the scanner's 512 KB cap).
 */
export function standardCorpus(): Corpus {
  const deployment = [
    "---",
    'title: "Deployment Guide"',
    "---",
    "# Deployment Guide",
    "",
    "## Pipelines",
    "",
    sent("The pipeline", ["deploy", 3], "runs the", ["service", 3], "on the deploy", ["cluster", 4], "with the deploy", ["config", 3], "file loaded from the deploy", ["repo", 2], "checkout."),
    sent("Rolling", ["deploys", 3], "replace the", ["deployed", 3], "instances one by one to keep the", ["deployment", 2], "healthy under the", ["deploy", 3], "policy."),
    sent("A failed", ["deploy", 2], "is retried by the pipeline controller and the", ["deploy", 3], "log is archived for the", ["deployment", 2], "audit."),
    "",
    "## Rollback",
    "",
    sent("Rollback", ["reverts", 2], "the", ["deploy", 3], "manifest to the previous", ["cluster", 2], "revision when a", ["deployment", 3], "regression is detected."),
    "",
    "## Preflight",
    "",
    sent("Preflight", ["checks", 3], "the", ["deploy", 2], "environment and requires a clean", ["repo", 3], "before any", ["deployment", 2], "starts."),
    "",
  ].join("\n");

  const testing = [
    "# Testing Handbook",
    "",
    "## Unit tests",
    "",
    sent("Unit", ["tests", 4], "cover pure functions; run the", ["test", 3], "suite with the", ["vitest", 2], "runner and record", ["test", 3], "coverage."),
    sent("Every", ["test", 4], "must assert behavior, not", ["testing", 2], "plumbing, to keep the", ["tests", 3], "meaningful."),
    "",
    "## Flaky",
    "",
    sent("Flaky", ["tests", 3], "are quarantined; a flaky", ["test", 3], "fails intermittently and the", ["testing", 2], "policy retires it after three strikes."),
    "",
  ].join("\n");

  const api = [
    "# API Reference",
    "",
    "## Endpoints",
    "",
    sent("The", ["endpoint", 4], "returns", ["json", 3], "for the", ["api", 3], "route; callers of the", ["endpoint", 2], "must send", ["json", 2], "bodies."),
    sent("The", ["api", 3], "gateway rate-limits each", ["endpoint", 3], "and rejects non-", ["json", 3], "payloads."),
    "",
    "## Auth",
    "",
    sent("OAuth", ["tokens", 4], "authenticate the", ["api", 3], "client; refresh the", ["token", 3], "before expiry to keep", ["oauth", 2], "sessions alive."),
    sent("An invalid", ["token", 3], "makes the", ["api", 2], "return 401 and the", ["oauth", 3], "server logs the refusal."),
    "",
  ].join("\n");

  const architecture = [
    "# Architecture Notes",
    "",
    "## Storage",
    "",
    sent("Storage", ["shards", 3], "the", ["database", 4], "by tenant; the", ["database", 3], "layer caches hot", ["shard", 2], "ranges."),
    sent("Write", ["amplification", 2], "in the", ["database", 3], "is bounded by the", ["storage", 2], "engine's journal."),
    "",
    "## Cache",
    "",
    sent("The", ["cache", 4], "evicts with LRU; a", ["cache", 3], "miss falls through to the", ["database", 2], "tier."),
    "",
  ].join("\n");

  const onboarding = [
    "# Onboarding",
    "",
    sent("Welcome to the team's", ["onboarding", 3], "guide; complete the", ["onboarding", 2], "checklist in the first", ["week", 3], "."),
    "",
  ].join("\n");

  const codeDoc = [
    "# Code Sample",
    "",
    "```json",
    "{ \"widget\": true, \"count\": 3 }",
    "```",
    "",
    "The snippet shows the widget", ["config", 3], "key used by the", ["widget", 2], "panel.",
    "",
  ].join("\n");

  return {
    "docs/deployment.md": deployment,
    "docs/testing.md": testing,
    "docs/api.md": api,
    "docs/architecture.md": architecture,
    "docs/onboarding.md": onboarding,
    "docs/code-sample.md": codeDoc,
    "docs/oversized.md": null,
  };
}

let seq = 0;

/** Create a temp project directory with the given files. Returns the root. */
export function makeTempProject(files: Corpus): string {
  const root = path.join(
    os.tmpdir(),
    `ntk-test-${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const text = content === null ? "padding ".repeat(600 * 1024) : content; // ~600 KB > cap
    fs.writeFileSync(abs, text, "utf8");
  }
  return root;
}

export function cleanupProject(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
