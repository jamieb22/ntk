// NTK-017 (restored): debug layer — flag, audit gate/schema/rollover,
// content strip, turn notices, file sink.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  audit, auditDispatch, debugTurn, flushDebugNotice, isDebugContent, isDebugEnabled, localReport,
  recordDebugOutcome, renderDebugNotice, sectionsFromBlock, setDebugEnabled, DEBUG_PREFIX, DEBUG_TAG,
} from "../src/core/debug-logging.js";

let root: string;
const T = (o: any) => ({ docPath: "a.md", sectionPath: "S", heading: "S", startLine: 1, endLine: 2, level: "full", tokens: 10, score: 5, ...o }) as any;
const TRACE: any = {
  terms: ["alpha"], expandedTerms: ["beta"], fired: true, passedGate: true, gateReason: "",
  latencyMs: 2, stages: { search: 1 }, items: ["a.md#S"], retained: [], spreadAdded: 0, spreadEvidence: [],
  excludedRedundant: [], excludedEmpty: [], excludedRelative: ["x#y"], truncated: ["z#1"],
  scored: [{ id: "a.md#S", docPath: "a.md", sectionPath: "S", startLine: 1, endLine: 2, score: 5, base: 4, matched: ["alpha"], exactTitle: false }],
  thresholds: { minScore: 3, minCoverage: 0.8, minSegTerms: 3, maxItems: 4, tokenBudget: 800, perDocMax: 1, redundancyMax: 0.75 },
  allocatedBudget: 800, allocatedSources: 2,
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ntkdbg-"));
  fs.mkdirSync(path.join(root, ".ntk"));
});

describe("NTK-017 flag + gates", () => {
  it("off by default; set/get roundtrip", () => {
    expect(isDebugEnabled(root)).toBe(false);
    setDebugEnabled(root, true);
    expect(isDebugEnabled(root)).toBe(true);
    setDebugEnabled(root, false);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".ntk", "debug.json"), "utf8"))).toEqual({ debug: false });
  });
  it("audit is inert when off; appends when on; content-free", () => {
    audit(root, { sessionID: "ses_abc12345", turnKey: "1|m1" }, { outcome: "DECLINED", reason: "r" });
    expect(fs.existsSync(path.join(root, ".ntk", "debug.jsonl"))).toBe(false);
    setDebugEnabled(root, true);
    auditDispatch(root, { sessionID: "ses_abc12345", turnKey: "1|m1" },
      { outcome: "INJECTED", via: "fresh selection", reason: "top score", trace: TRACE, items: [T({})], tokens: 10 });
    const line = JSON.parse(fs.readFileSync(path.join(root, ".ntk", "debug.jsonl"), "utf8").toString().trim().split("\n").at(-1)!);
    expect(line).toMatchObject({ ev: "dispatch", session: "abc12345", turnKey: "1|m1", outcome: "INJECTED" });
    expect(line.rejected.relative).toEqual(["x#y"]);
    expect(line.items[0].doc).toBe("a.md");
    expect(line.thresholds.minScore).toBe(3);
    expect(JSON.stringify(line)).not.toContain("content");
    expect(JSON.stringify(line)).not.toContain("lorem");
  });
  it("8 MB rollover", () => {
    setDebugEnabled(root, true);
    fs.writeFileSync(path.join(root, ".ntk", "debug.jsonl"), "x".repeat(9 * 1024 * 1024));
    audit(root, { sessionID: "s", turnKey: "t" }, { outcome: "REUSED" });
    expect(fs.existsSync(path.join(root, ".ntk", "debug.jsonl.1"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".ntk", "debug.jsonl"), "utf8").trim().endsWith("}")).toBe(true);
  });
});

describe("NTK-017 strip + notices + sink", () => {
  it("isDebugContent: tag, synthetic role, prefix; never plain user text", () => {
    expect(isDebugContent({ metadata: { tag: DEBUG_TAG } })).toBe(true);
    expect(isDebugContent({ role: "synthetic" })).toBe(true);
    expect(isDebugContent({}, { text: DEBUG_PREFIX + " INJECTED: 1 section" })).toBe(true);
    expect(isDebugContent({ role: "user", content: [{ type: "text", text: "he said NTK-DEBUG: ON" }] })).toBe(false);
  });
  it("turn accumulator + flush once", () => {
    setDebugEnabled(root, true);
    recordDebugOutcome(root, "s1", "1|m1", { outcome: "DECLINED", reason: "coverage 0.2", recalculated: true });
    recordDebugOutcome(root, "s1", "1|m1", { outcome: "INJECTED", sections: "1 section(s), ~10tok: a.md#S (full)", tokens: 10, recalculated: true });
    const t = debugTurn.get("s1")!;
    expect(t.counts.DECLINED).toBe(1);
    expect(t.counts.INJECTED).toBe(1);
    const notice = renderDebugNotice(t);
    expect(notice).toContain("NTK-DEBUG: INJECTED");
    expect(notice).toContain("DECLINED 1");
    let flushed = "";
    flushDebugNotice("s1", (l) => (flushed = l));
    expect(flushed).toContain("2 dispatches");
    let again = "";
    flushDebugNotice("s1", (l) => (again = l));
    expect(again).toBe("");
  });
  it("localReport writes status.md + one log line; never throws", () => {
    const lines: string[] = [];
    localReport(root, "MULTI\nline report", (l) => lines.push(l));
    expect(lines).toEqual(["MULTI"]);
    expect(fs.readFileSync(path.join(root, ".ntk", "status.md"), "utf8")).toContain("line report");
  });
  it("sectionsFromBlock parses rendered block", () => {
    const s = sectionsFromBlock("Source: docs/x.md#Alpha (full)\nSource: docs/y.md#Beta (excerpt)");
    expect(s).toContain("2 section(s)");
    expect(s).toContain("docs/x.md#Alpha (full)");
  });
});
